import { assertCanWrite } from './admin.js';
import { productionHosts, trustedEnv, type TrustedEnv } from './envs.js';
import { TrustError } from './errors.js';
import { isOrigin } from './init.js';
import { isPrivateHost } from '../foundation/index.js';
import type { OwnerKey } from './owner-key.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

/** Which of an env's origin sets an origin joins: pages it may open, or origins its pages may call. */
export type OriginSet = 'visit' | 'call';

const invalid = (message: string): TrustError =>
  new TrustError('trust_entry_invalid', message);

/**
 * Checks that `origin` may join the `set` of env `name` (`flowctl trust add origin`, ADR 0025 section 2, `envs`) and
 * returns the env as it is now, for the confirmation screen.
 *
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store, an env the store does not have, a `production` env
 *   (its origins are production origins and need read-only replay, which is not built), a value that is not a bare
 *   origin, the env's own origin, an origin on a production host, plain `http` off this machine's network, or an
 *   origin already listed; `trust_tampered` for an entry that is not owner-signed.
 */
export function checkEnvOrigin(
  store: TrustStore,
  name: string,
  set: OriginSet,
  origin: string,
): TrustedEnv {
  if (store.isCi)
    throw invalid(
      'This trust store is marked ci and is read-only; change it on the owner machine and re-provision it.',
    );
  const env = trustedEnv(store, name);
  if (env === undefined)
    throw invalid(
      `The env "${name}" is not in the trust store; add it first with: flowctl trust add env ${name}`,
    );
  if (env.class === 'production')
    throw invalid(
      `The env "${name}" is production; runs never reach production, so it gets no extra origins.`,
    );
  if (!isOrigin(origin))
    throw invalid(
      `"${origin}" is not an origin: type the scheme, host and port only, e.g. https://api.example.com.`,
    );
  const canonical = new URL(origin).origin;
  if (canonical === env.origin)
    throw invalid(`${origin} is the env's own origin; it is always in scope.`);
  const host = new URL(canonical).hostname.toLowerCase();
  if (productionHosts(store).includes(host.replace(/\.$/, '')))
    throw invalid(
      `${origin} is on a production host (a production origin, or a production env's origin); runs never reach it.`,
    );
  if (
    canonical.startsWith('http:') &&
    !isPrivateHost(new URL(canonical).hostname)
  )
    throw invalid(
      `${origin} is plain http to another network; a run only reaches https there.`,
    );
  const list = set === 'visit' ? env.visitOrigins : env.callOrigins;
  if (list.includes(canonical))
    throw invalid(
      `The env "${name}" already lists ${canonical} in its ${set} origins; nothing was changed.`,
    );
  return env;
}

/**
 * Adds `origin` to the `set` (`visitOrigins` or `callOrigins`) of env `name` and signs the env entry again with the
 * owner key. A run on the env may then open (`visit`) or call (`call`) that origin, within the repo's `target.scope`
 * (ADR 0024 sections 1 and 3).
 *
 * @throws {TrustError} every refusal of {@link checkEnvOrigin}; `store_busy`; `trust_tampered` when the key is not
 *   the pinned owner key.
 */
export function addEnvOrigin(
  store: TrustStore,
  key: OwnerKey,
  name: string,
  set: OriginSet,
  origin: string,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const env = checkEnvOrigin(fresh, name, set, origin);
  const canonical = new URL(origin).origin;
  const value = {
    origin: env.origin,
    class: env.class,
    visitOrigins:
      set === 'visit' ? [...env.visitOrigins, canonical] : env.visitOrigins,
    callOrigins:
      set === 'call' ? [...env.callOrigins, canonical] : env.callOrigins,
  };
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      envs: {
        ...fresh.data.envs,
        [name]: {
          ...value,
          sig: key.signEntry({ id: name, kind: 'envs', value }),
        },
      },
    },
    key,
  );
}
