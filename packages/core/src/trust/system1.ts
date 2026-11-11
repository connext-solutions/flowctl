import { assertCanWrite } from './admin.js';
import { ENV_VAR_NAME } from './env-vars.js';
import { isLoopback, productionOriginFor, trustedEnv } from './envs.js';
import { TrustError } from './errors.js';
import type { OwnerKey } from './owner-key.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

/** The `system1` section of the store, after its owner signature was verified. */
export interface TrustedSystem1 {
  allowedHosts: string[];
  apiKeyEnvs: string[];
  allowedEnvs: string[];
}

/** What one `flowctl trust add system1` adds: an endpoint host, a key variable name, envs. */
export interface System1Addition {
  host: string;
  apiKeyEnv: string;
  envs: string[];
}

const invalid = (message: string): TrustError =>
  new TrustError('trust_entry_invalid', message);

const MAX_PORT = 65_535;

/**
 * `host:port` as the store keeps it: lowercase, port always written. `https://` on 443 and `http://` on 80 are
 * written with that port, so the comparison never depends on a default.
 *
 * @returns the normalised `host:port`, or `undefined` for a URL that is not http(s).
 */
export function hostPortOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined;
    const port =
      u.port === '' ? (u.protocol === 'https:' ? '443' : '80') : u.port;
    return `${u.hostname.toLowerCase()}:${port}`;
  } catch {
    return undefined;
  }
}

/**
 * The store's `system1` section, verified against the owner key on this read.
 *
 * @returns the section, or `undefined` when the owner has not recorded one.
 * @throws {TrustError} `trust_tampered` when it is not owner-signed.
 */
export function trustedSystem1(store: TrustStore): TrustedSystem1 | undefined {
  const s = store.data.system1;
  if (s === undefined) return undefined;
  const { sig, ...value } = s;
  store.assertSigned({ id: 'system1', kind: 'system1', value }, sig);
  return value;
}

/**
 * Checks one addition and returns the section it would make, so the CLI can show the old and the new section before
 * the owner confirms. Each env must be one the store trusts with class `local` or `shared`, on no production host
 * (ADR 0005 and ADR 0024 section 2: System 1 never runs on production).
 *
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store, a host that is not `host:port` (or not loopback in a
 *   `test` store, ADR 0025 section 1), a key name that is not
 *   an exact variable name, an env the store does not trust or classes `production`, or nothing new; `trust_tampered`
 *   for an entry that is not owner-signed.
 */
export function planSystem1(
  store: TrustStore,
  add: System1Addition,
): { before: TrustedSystem1 | undefined; after: TrustedSystem1 } {
  if (store.isCi)
    throw invalid(
      'This trust store is marked ci and is read-only; change it on the owner machine and re-provision it.',
    );
  const host = hostPortOf(`https://${add.host}`);
  if (
    host === undefined ||
    host !== add.host.toLowerCase() ||
    !hasPort(add.host)
  )
    throw invalid(
      `"${add.host}" is not host:port; type the System 1 endpoint's host and port, e.g. api.typesafe.ai:443.`,
    );
  if (store.isTest && !isLoopback(`https://${add.host}`))
    throw invalid(
      `A test store allows only a System 1 on this machine (the localhost fake); ${add.host} is refused.`,
    );
  if (!ENV_VAR_NAME.test(add.apiKeyEnv))
    throw invalid(
      `"${add.apiKeyEnv}" is not an exact environment variable name (letters, digits and _, not starting with a digit).`,
    );
  if (add.envs.length === 0)
    throw invalid('Name at least one env System 1 may run in.');
  for (const name of add.envs) {
    const env = trustedEnv(store, name);
    if (env === undefined)
      throw invalid(
        `The env "${name}" is not in the trust store; classify it first with: flowctl trust add env ${name}`,
      );
    if (
      env.class === 'production' ||
      productionOriginFor(store, env.origin) !== undefined
    )
      throw invalid(
        `The env "${name}" is production; System 1 never runs there (ADR 0005).`,
      );
  }
  const before = trustedSystem1(store);
  const union = (a: string[] | undefined, b: string[]): string[] => [
    ...new Set([...(a ?? []), ...b]),
  ];
  const after: TrustedSystem1 = {
    allowedHosts: union(before?.allowedHosts, [host]),
    apiKeyEnvs: union(before?.apiKeyEnvs, [add.apiKeyEnv]),
    allowedEnvs: union(before?.allowedEnvs, add.envs),
  };
  if (
    before !== undefined &&
    after.allowedHosts.length === before.allowedHosts.length &&
    after.apiKeyEnvs.length === before.apiKeyEnvs.length &&
    after.allowedEnvs.length === before.allowedEnvs.length
  )
    throw invalid('The store already allows all of this; nothing was changed.');
  return { before, after };
}

const hasPort = (hostPort: string): boolean => {
  const port = Number(hostPort.slice(hostPort.lastIndexOf(':') + 1));
  return /:\d{1,5}$/.test(hostPort) && port >= 1 && port <= MAX_PORT;
};

/**
 * Adds a System 1 endpoint host, key variable name and envs to the store's `system1` section
 * (`flowctl trust add system1`), signed with the owner key. Existing values are kept.
 *
 * @throws {TrustError} every refusal of {@link planSystem1}; `store_busy`; `trust_tampered` when the key is not the
 *   pinned owner key.
 */
export function addSystem1(
  store: TrustStore,
  key: OwnerKey,
  add: System1Addition,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const { after } = planSystem1(fresh, add);
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      system1: {
        ...after,
        sig: key.signEntry({ id: 'system1', kind: 'system1', value: after }),
      },
    },
    key,
  );
}
