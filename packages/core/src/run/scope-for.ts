import type { Scope } from '../browser/index.js';
import type { LoadedConfig, ResolvedEnv } from '../config.js';
import {
  isLoopback,
  openTrustStore,
  productionHosts,
  type TrustStore,
} from '../trust/index.js';

/**
 * The scope of a run on `env` (ADR 0024 section 3): the effective configuration's scope for the env when it has one,
 * else the env's own origin for both sets (a config read without the trust store, as library callers and tests use);
 * the repo's `allow` and `deny`; and every production host the store knows (its production origins, and every env
 * classed `production` with that env's own origins).
 *
 * @param store the run's store; `'default'` opens the owner's store only for an env off this machine, as the
 *   exploration guard does, so tests on the local fixture never read it.
 * @throws {TrustError} `trust_tampered` when a production entry is not owner-signed.
 */
export function scopeFor(
  cfg: LoadedConfig,
  env: ResolvedEnv,
  store: TrustStore | 'default',
): Scope {
  const envOrigin = new URL(env.baseUrl).origin;
  const sets = cfg.trustView?.scopes?.[env.name] ?? {
    visit: [envOrigin],
    call: [envOrigin],
  };
  const s =
    store === 'default'
      ? isLoopback(envOrigin)
        ? undefined
        : openTrustStore()
      : store;
  const hosts = s === undefined ? [] : productionHosts(s);
  return {
    envOrigin,
    visit: sets.visit,
    call: sets.call,
    allow: cfg.target.scope.allow,
    deny: cfg.target.scope.deny,
    productionHosts: hosts,
  };
}
