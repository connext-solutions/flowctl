import { ConfigError, type LoadedConfig } from '../config.js';
import { RunError } from '../run/index.js';
import { JevDriver } from './jev.js';
import type { DecideInput, Decision } from './protocol.js';

/**
 * System 1 as the exploration loop and heal see it (ADR 0022): it ranks operations and proposes a control and an
 * input key; it never decides a verdict (ADR 0004).
 */
export interface Driver {
  /** A stable adapter name (`jev`). */
  readonly id: string;
  /**
   * One decision for the page in `input`.
   *
   * @param signal the run's wall-clock budget; aborting it stops the call (ADR 0024 section 6).
   * @throws {RunError} `system1_unreachable` when the backend cannot answer usefully.
   */
  decide(input: DecideInput, signal?: AbortSignal): Promise<Decision>;
}

declare const CHECKED: unique symbol;

/**
 * A {@link Driver} that {@link createDriver} made for one env. The brand exists only for the type checker; at run
 * time {@link assertDriverFor} checks the instance against the factory's own registry.
 */
export type CheckedDriver = Driver & { readonly [CHECKED]: true };

/** Every driver {@link createDriver} returned, with the env it was checked for. Module-private, never exported. */
const issued = new WeakMap<object, string>();

const isChecked = (d: Driver): d is CheckedDriver => issued.has(d);

/**
 * Refuses a driver that {@link createDriver} did not make for `env`: one built directly, a look-alike object, or a
 * driver checked for another env (issue #15, ADR 0005). Called by the exploration loop, heal and replay.
 *
 * @throws {RunError} `system1_not_allowed`.
 */
export function assertDriverFor(
  d: Driver | undefined,
  env: string,
): asserts d is CheckedDriver {
  const allowed = d === undefined ? undefined : issued.get(d);
  if (allowed !== env)
    throw new RunError(
      'system1_not_allowed',
      `This System 1 driver was allowed for env "${allowed ?? 'none'}", not "${env}"; System 1 runs only on an env in system1.allowedEnvs`,
    );
}

/**
 * The System 1 driver for `env`: the only way to obtain a {@link CheckedDriver} (ADR 0022).
 *
 * @param cfg the effective configuration (`effectiveConfig`): its `system1` section is already narrowed to what
 *   the trust store allows (envs, endpoint `host:port`, key variable name), and a refusal is on `trustView`.
 * @param vars where the API key variable named by `system1.apiKeyEnv` is read.
 * @throws {RunError} `system1_not_allowed` when `env` is not in `system1.allowedEnvs` (ADR 0005), or the trust
 *   store does not allow the endpoint or the key variable (ADR 0024 section 1).
 * @throws {ConfigError} when the config has no `system1` section, or the API key variable is unset or malformed, or
 *   the endpoint is not a plain https URL (http only to this machine).
 */
export function createDriver(
  cfg: LoadedConfig,
  env: string,
  vars: NodeJS.ProcessEnv = process.env,
): CheckedDriver {
  const s1 = cfg.system1;
  if (s1 === undefined)
    throw new ConfigError(
      'flowctl.config.yaml has no system1 section; exploration and heal need one',
    );
  const refused = cfg.trustView?.system1Refused;
  if (refused !== undefined) throw new RunError('system1_not_allowed', refused);
  if (!s1.allowedEnvs.includes(env))
    throw new RunError(
      'system1_not_allowed',
      `System 1 is not allowed on env "${env}" (system1.allowedEnvs: ${s1.allowedEnvs.join(', ')}); only replay without heal runs there`,
    );
  const apiKey = vars[s1.apiKeyEnv];
  if (apiKey === undefined || apiKey === '')
    throw new ConfigError(`Set ${s1.apiKeyEnv} to use System 1`);
  const d: Driver = new JevDriver({
    baseUrl: s1.baseUrl,
    apiKey,
    model: s1.model,
  });
  issued.set(d, env);
  if (!isChecked(d))
    throw new RunError('internal', 'System 1 driver registry failed');
  return d;
}

/**
 * The earlier name of the factory.
 *
 * @deprecated Use {@link createDriver}; `System1Client.fromConfig` is the same function. The class it named is
 *   now `JevDriver`, which is built only by the factory.
 */
export const System1Client = { fromConfig: createDriver } as const;
