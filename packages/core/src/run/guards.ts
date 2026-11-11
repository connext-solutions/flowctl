import { BUILT_IN_DENY, pathGlob } from '../browser/index.js';
import type { LoadedConfig, ResolvedEnv } from '../config.js';
import { RunError } from '../foundation/index.js';
import {
  isLoopback,
  openTrustStore,
  type ReadContext,
  TrustError,
  trustedEnv,
  type TrustStore,
} from '../trust/index.js';
import { RequestGuard, type RequestClass } from './request-guard.js';
import { ScopeGuard, scopeFor } from './scope-guard.js';

const hostOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

/**
 * The class the guards use for `origin`: `production` when the store lists a production origin on the same
 * host (any scheme or port, ADR 0024 section 2); else the store's class for an env on exactly this origin;
 * else `local` for loopback and `unknown` otherwise.
 *
 * @remarks Only the matching entries are verified, so one bad entry for another env does not stop every
 *   run. The default store is opened only for a non-loopback origin, so tests on a local fixture never
 *   read the owner's store.
 * @throws {TrustError} `trust_tampered` when a matching entry is not owner-signed.
 */
export function envClassFor(
  origin: string,
  store: TrustStore | undefined,
): RequestClass {
  const s = store ?? (isLoopback(origin) ? undefined : openTrustStore());
  if (s !== undefined) {
    const host = hostOf(origin);
    for (const [p, entry] of Object.entries(s.data.productionOrigins))
      if (hostOf(p) === host) {
        s.assertSigned(
          { id: p, kind: 'productionOrigins', value: {} },
          entry.sig,
        );
        return 'production';
      }
    for (const [name, e] of Object.entries(s.data.envs))
      if (e.origin === origin) {
        const verified = trustedEnv(s, name);
        if (verified !== undefined) return verified.class;
      }
  }
  return isLoopback(origin) ? 'local' : 'unknown';
}

/**
 * The scope guard of a run of `flow` on `env` ({@link scopeFor}), with its request layer: the caller's
 * (`opts.writes`, an exploration's), else the replay layer of {@link RequestGuard.forReplay} for the env's class.
 *
 * @throws {RunError} `scope_violation` when the trust store cannot be read for the production hosts or the env's
 *   class.
 */
export function guardFor(
  cfg: LoadedConfig,
  env: ResolvedEnv,
  flow: string,
  opts: { store?: TrustStore; writes?: RequestGuard },
): ScopeGuard {
  try {
    const writes =
      opts.writes ??
      RequestGuard.forReplay(
        envClassFor(new URL(env.baseUrl).origin, opts.store),
        flow,
        cfg.target.destructiveWords,
      );
    return new ScopeGuard(scopeFor(cfg, env, opts.store ?? 'default'), writes);
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    throw new RunError(
      'scope_violation',
      `The trust store refused the run's scope (${e.kind}${e.detail === undefined ? '' : `: ${e.detail}`}): ${e.message}`,
    );
  }
}

/**
 * What reading `destructiveConfirm` entries needs from the run layer: now, and the `deny` matcher a `session`
 * template is judged by (the built-in list of `browser/scope.ts` and the repo's `target.scope.deny`, case-folded).
 */
export function confirmReadContext(
  cfg: LoadedConfig,
  now: Date = new Date(),
): ReadContext {
  const deny = [...BUILT_IN_DENY, ...cfg.target.scope.deny].map((p) =>
    pathGlob(p, true),
  );
  return { now, denied: (path) => deny.some((re) => re.test(path)) };
}
