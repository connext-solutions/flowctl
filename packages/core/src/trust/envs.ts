import { assertCanWrite } from './admin.js';
import { TrustError } from './errors.js';
import {
  assertEnvsConsistent,
  signEnv,
  type TrustedEnvAnswer,
} from './init.js';
import type { OwnerKey } from './owner-key.js';
import type { EnvClass } from './schema.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** True when `origin` names this machine: `localhost`, `127.0.0.1` or `[::1]`. */
export function isLoopback(origin: string): boolean {
  try {
    return LOOPBACK.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** An env as the trust store records it, after its owner signature was verified. */
export interface TrustedEnv {
  origin: string;
  class: EnvClass;
  visitOrigins: string[];
  callOrigins: string[];
}

/**
 * The env `name` of the store, verified against the owner key on this read (ADR 0025 section 3; the owner
 * decided on 2026-11-02 that env entries are signed).
 *
 * @remarks A signature covers one entry, so a deleted entry leaves nothing to verify: until `trust.log` and the
 *   anchor land, a missing env must be read as untrusted (refuse), never as permission.
 * @returns the env, or `undefined` when the store has no entry for it (the caller then refuses with
 *   `env_not_trusted`).
 * @throws {TrustError} `trust_tampered` when the entry is not owner-signed.
 */
export function trustedEnv(
  store: TrustStore,
  name: string,
): TrustedEnv | undefined {
  const envs = store.data.envs;
  const e = Object.hasOwn(envs, name) ? envs[name] : undefined;
  if (e === undefined) return undefined;
  const { sig, ...value } = e;
  store.assertSigned({ id: name, kind: 'envs', value }, sig ?? '');
  return value;
}

/**
 * True when the owner typed `origin` as a production origin, verified against the owner key on this read.
 *
 * @remarks `false` is not proof: deleting the entry from `trust.json` leaves nothing to verify until
 *   `trust.log` and the anchor land. A production guard must also treat an env whose class is `production` as
 *   production, and must not rely on this function alone.
 * @throws {TrustError} `trust_tampered` when the entry is not owner-signed.
 */
export function isProductionOrigin(store: TrustStore, origin: string): boolean {
  const all = store.data.productionOrigins;
  const p = Object.hasOwn(all, origin) ? all[origin] : undefined;
  if (p === undefined) return false;
  store.assertSigned(
    { id: origin, kind: 'productionOrigins', value: {} },
    p.sig,
  );
  return true;
}

/**
 * The host of `origin` as production matching compares it (ADR 0024 section 2): lowercase, without scheme, port or
 * one trailing dot, so `https://erp.example.com.` and `https://erp.example.com` are one host.
 *
 * @returns the host, or `undefined` for a value that is not a URL.
 */
export const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return undefined;
  }
};

/**
 * The production origin that covers `origin`: a production entry covers every scheme and port of its host (ADR 0024
 * section 2). Each candidate is verified against the owner key.
 *
 * @returns the covering production origin, or `undefined`.
 * @throws {TrustError} `trust_tampered` when a matching entry is not owner-signed.
 */
export function productionOriginFor(
  store: TrustStore,
  origin: string,
): string | undefined {
  const host = hostOf(origin);
  if (host === undefined) return undefined;
  for (const p of Object.keys(store.data.productionOrigins))
    if (hostOf(p) === host && isProductionOrigin(store, p)) return p;
  return undefined;
}

/**
 * Every production host the store knows (ADR 0024 section 2, ADR 0025 section 2 `envs`): the hosts of its production
 * origins, and of every env classed `production` together with that env's `visitOrigins` and `callOrigins`. Each entry
 * read is verified against the owner key.
 *
 * @throws {TrustError} `trust_tampered` when an entry is not owner-signed.
 */
export function productionHosts(store: TrustStore): string[] {
  const hosts = new Set<string>();
  const add = (origin: string): void => {
    const h = hostOf(origin);
    if (h !== undefined) hosts.add(h);
  };
  for (const o of Object.keys(store.data.productionOrigins))
    if (isProductionOrigin(store, o)) add(o);
  for (const name of Object.keys(store.data.envs)) {
    const e = trustedEnv(store, name);
    if (e?.class === 'production')
      for (const o of [e.origin, ...e.visitOrigins, ...e.callOrigins]) add(o);
  }
  return [...hosts];
}

/**
 * Adds one owner-classified env to the store (`flowctl trust add env`, ADR 0025 section 3), signed with the
 * owner key. An existing entry is never replaced: forgetting it is a separate, later command.
 *
 * @remarks The store is read again here, after the owner answered, so a change written meanwhile is kept;
 *   without the lock of Amendment 2026-11-02 section 7 a write in the same instant can still be lost.
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store, a non-loopback or non-`local` env in a `test`
 *   store (section 1), an env that already exists, a bad origin, or a
 *   class that contradicts another env on the same origin or a production origin; `trust_tampered` when the
 *   key is not the pinned owner key or an existing env entry is not owner-signed.
 */
export function addTrustedEnv(
  store: TrustStore,
  key: OwnerKey,
  name: string,
  env: TrustedEnvAnswer,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  if (fresh.isTest && (env.class !== 'local' || !isLoopback(env.origin)))
    throw new TrustError(
      'trust_entry_invalid',
      `A test store holds only loopback origins of class local; ${env.origin} (${env.class}) is refused.`,
    );
  if (Object.hasOwn(fresh.data.envs, name))
    throw new TrustError(
      'trust_entry_invalid',
      `The env "${name}" is already in the trust store; nothing was changed.`,
    );
  const known: Record<string, TrustedEnvAnswer> = { [name]: env };
  for (const other of Object.keys(fresh.data.envs)) {
    const e = trustedEnv(fresh, other);
    if (e !== undefined) known[other] = e;
  }
  const production = Object.keys(fresh.data.productionOrigins).filter((o) =>
    isProductionOrigin(fresh, o),
  );
  assertEnvsConsistent(known, production);
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      envs: { ...fresh.data.envs, [name]: signEnv(key, name, env) },
    },
    key,
  );
}
