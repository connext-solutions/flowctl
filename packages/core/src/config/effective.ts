import type { LoadedConfig, TrustView } from '../config.js';
import {
  type EnvClass,
  hostPortOf,
  isLoopback,
  productionOriginFor,
  type Trusted,
  trustedEnv,
  trustedProject,
  type TrustedSystem1,
  trustedSystem1,
} from '../trust/index.js';
import { capNumbers, MIN_CONFIDENCE } from './ceilings.js';
import { type EnvCeiling, narrowTarget } from './target.js';

/** The configuration a guarded command runs with, and the warnings for every repo value that was ignored or capped. */
export interface EffectiveConfig {
  cfg: LoadedConfig;
  warnings: string[];
}

/** System 1 runs only where the store's class allows it: never on production, never on an env it does not trust. */
const SYSTEM1_CLASSES: ReadonlySet<EnvClass> = new Set(['local', 'shared']);

/** The origin of `url` resolved against `base`, the way a browser opens it, or `undefined` when it does not resolve. */
const originOf = (url: string, base?: string): string | undefined => {
  try {
    return new URL(url, base).origin;
  } catch {
    return undefined;
  }
};

/**
 * The repo `flowctl.config.yaml` intersected with the trust store (ADR 0024 section 1, "effective configuration";
 * T1.1). A repo value can only narrow what the store and the built-in defaults allow:
 * - an env is honoured only when the store has an env of that name on the same origin: `baseUrl`, and `loginUrl`
 *   resolved against it as the browser opens it (so `//host` and `/\\host` count as other origins); otherwise
 *   selecting it ends `env_not_trusted` (section 2);
 * - an env's class is `production` when a production origin covers its host (any scheme or port, section 2), whatever
 *   class its entry has;
 * - `defaultEnv` is the one the owner recorded for the project; a different repo value is ignored with a warning. A
 *   production default, a recorded default missing from the config, or none recorded makes a command without `--env`
 *   end `env_not_trusted` (section 5);
 * - `system1.allowedEnvs` keeps only envs whose class is `local` or `shared`;
 * - `system1.confidenceThreshold` may only be raised above the built-in 0.5;
 * - with a store `system1` section, `system1.allowedEnvs` must also be in its list, and an endpoint or key variable
 *   outside it turns System 1 off (`system1_not_allowed`);
 * - `maxSteps`, `runsRetention` and the timeouts are capped at their built-in ceilings ({@link CEILINGS});
 * - the `target:` section is narrowed by `narrowTarget`, and each trusted env's scope is recorded on `trustView`.
 *
 * @remarks Not yet intersected (later chunks of T1.1): the path containment of section 1a
 *   (`flowsDir` is already required to be the registered flows root by `requireTrust`). `envs.<n>.vars` are values
 *   for templates only and never an origin, so they need no rule.
 *   Every env of the config is read from the store, so one entry that is not owner-signed stops every guarded
 *   command, even one that would not use that env (fail closed; the exploration guard `envClassFor` reads only the
 *   entry for the origin it runs on).
 * @throws {TrustError} `trust_tampered` when an entry it reads is not owner-signed.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export function effectiveConfig(
  cfg: LoadedConfig,
  trusted: Trusted,
): EffectiveConfig {
  const { store, project } = trusted;
  const warnings: string[] = [];
  const view: TrustView = { refused: {} };
  const classes = new Map<string, EnvClass>();
  const ceilings = new Map<string, EnvCeiling>();
  for (const [name, env] of Object.entries(cfg.envs)) {
    const t = trustedEnv(store, name);
    const origin = originOf(env.baseUrl);
    const login =
      env.loginUrl === undefined ? origin : originOf(env.loginUrl, env.baseUrl);
    if (t === undefined)
      view.refused[name] =
        `The env "${name}" is not in the trust store. To trust it on this machine, run: flowctl trust add env ${name}`;
    else if (origin !== t.origin)
      view.refused[name] =
        `The env "${name}" points at ${origin ?? env.baseUrl} in flowctl.config.yaml, but the trust store records ${t.origin}; the run is refused. Restore baseUrl, or classify the new origin as another env.`;
    else if (login !== t.origin)
      view.refused[name] =
        `The loginUrl of env "${name}" opens ${login ?? env.loginUrl ?? ''}, not the trusted origin ${t.origin}; the run is refused. Use a path such as /login.`;
    else {
      classes.set(
        name,
        productionOriginFor(store, t.origin) === undefined
          ? t.class
          : 'production',
      );
      ceilings.set(name, t);
    }
  }
  const recorded = trustedProject(store, project)?.defaultEnv;
  let defaultEnv = cfg.defaultEnv;
  if (recorded === undefined)
    view.noDefault = `The trust store records no default env for project "${project}"; pass --env, or record one with: flowctl trust add default-env <env>`;
  else if (recorded !== cfg.defaultEnv) {
    warnings.push(
      `defaultEnv "${cfg.defaultEnv}" in flowctl.config.yaml differs from the default env the owner recorded ("${recorded}"); "${recorded}" is used. Change it with: flowctl trust add default-env <env>`,
    );
    defaultEnv = recorded;
  }
  if (view.noDefault !== undefined) return finish();
  if (!Object.hasOwn(cfg.envs, defaultEnv))
    view.noDefault = `The default env "${defaultEnv}" recorded in the trust store is not in flowctl.config.yaml; pass --env, or add it to the config.`;
  else if (classes.get(defaultEnv) === 'production')
    view.noDefault = `The default env "${defaultEnv}" is a production env; name it with --env to run there.`;
  return finish();

  function finish(): EffectiveConfig {
    const system1 =
      cfg.system1 === undefined
        ? undefined
        : narrowSystem1(
            cfg.system1,
            classes,
            trustedSystem1(store),
            view,
            warnings,
          );
    const narrowed = narrowTarget(
      cfg.target,
      ceilings,
      Object.keys(cfg.profiles),
      warnings,
    );
    view.scopes = narrowed.scopes;
    const capped = capNumbers({
      ...cfg,
      defaultEnv,
      system1,
      target: narrowed.target,
      trustView: view,
    });
    return { cfg: capped.cfg, warnings: [...warnings, ...capped.warnings] };
  }
}

/**
 * The repo `system1` settings inside what the store allows. Without a store `system1` section (owner decision
 * 2026-11-09) only the env class rule applies; with one, the envs must also be in its `allowedEnvs`, and an endpoint
 * outside `allowedHosts` or a key variable outside `apiKeyEnvs` turns System 1 off (`system1_not_allowed`). A plain
 * `http:` endpoint off this machine always turns it off: only the localhost fake may be reached without TLS.
 */
function narrowSystem1(
  s1: NonNullable<LoadedConfig['system1']>,
  classes: ReadonlyMap<string, EnvClass>,
  stored: TrustedSystem1 | undefined,
  view: TrustView,
  warnings: string[],
): NonNullable<LoadedConfig['system1']> {
  const allowedEnvs = s1.allowedEnvs.filter((name) => {
    const c = classes.get(name);
    return (
      c !== undefined &&
      SYSTEM1_CLASSES.has(c) &&
      (stored === undefined || stored.allowedEnvs.includes(name))
    );
  });
  const dropped = s1.allowedEnvs.filter((n) => !allowedEnvs.includes(n));
  if (dropped.length > 0)
    warnings.push(
      stored === undefined
        ? `system1.allowedEnvs lists ${dropped.join(', ')}, which the trust store does not class local or shared; System 1 stays off there.`
        : `system1.allowedEnvs lists ${dropped.join(', ')}, which the trust store does not allow for System 1; System 1 stays off there.`,
    );
  const host = hostPortOf(s1.baseUrl);
  const allowed = stored?.allowedHosts ?? [];
  if (s1.baseUrl.startsWith('http:') && !isLoopback(s1.baseUrl))
    view.system1Refused = `system1.baseUrl ${s1.baseUrl} is plain http to another machine, which would send the key and page text unencrypted; use https.`;
  else if (
    stored !== undefined &&
    (host === undefined || !allowed.includes(host))
  )
    view.system1Refused = `system1.baseUrl points at ${host ?? s1.baseUrl}, which the trust store does not allow (${allowed.length === 0 ? 'none' : allowed.join(', ')}). Restore it, or allow the host with: flowctl trust add system1 <host:port> <KEY_ENV> <env...>`;
  else if (stored !== undefined && !stored.apiKeyEnvs.includes(s1.apiKeyEnv))
    view.system1Refused = `system1.apiKeyEnv ${s1.apiKeyEnv} is not a key variable the trust store allows (${stored.apiKeyEnvs.join(', ')}). Restore it, or allow it with: flowctl trust add system1 <host:port> ${s1.apiKeyEnv} <env...>`;
  let confidenceThreshold = s1.confidenceThreshold;
  if (confidenceThreshold < MIN_CONFIDENCE) {
    warnings.push(
      `system1.confidenceThreshold ${confidenceThreshold} is below the built-in ${MIN_CONFIDENCE}; ${MIN_CONFIDENCE} is used.`,
    );
    confidenceThreshold = MIN_CONFIDENCE;
  }
  return { ...s1, allowedEnvs, confidenceThreshold };
}
