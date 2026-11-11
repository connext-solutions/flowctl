import type { LoadedConfig } from '../config.js';
import { MAX_STEPS_CAP } from '../foundation/index.js';

/** The numeric repo keys the effective configuration caps (ADR 0024 section 1, per-key matrix). */
export type CappedKey =
  | 'maxSteps'
  | 'runsRetention'
  | 'assertTimeout'
  | 'stepTimeout'
  | 'navigationTimeout'
  | 'hookTimeout';

/**
 * The built-in ceiling of each numeric repo key: a larger repo value is capped with a warning. ADR 0024 names the
 * rule but no numbers; these are flowctl's interim choice, an open owner decision:
 * `maxSteps` is the cap on an exploration request (`MAX_STEPS_CAP`), `assertTimeout` six times its default,
 * `stepTimeout` twelve, `navigationTimeout` four, `hookTimeout` five, `runsRetention` ten.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export const CEILINGS: Readonly<Record<CappedKey, number>> = {
  maxSteps: MAX_STEPS_CAP,
  runsRetention: 200,
  assertTimeout: 60_000,
  stepTimeout: 60_000,
  navigationTimeout: 120_000,
  hookTimeout: 600_000,
};

/** The built-in `system1.confidenceThreshold`; a repo may only raise it (ADR 0024 section 1). */
export const MIN_CONFIDENCE = 0.5;

/** `cfg` with every capped key min-ed with its ceiling, and a warning per key that was capped. */
export function capNumbers(cfg: LoadedConfig): {
  cfg: LoadedConfig;
  warnings: string[];
} {
  const warnings: string[] = [];
  const out = { ...cfg };
  for (const [key, max] of Object.entries(CEILINGS))
    if (isCapped(key) && out[key] > max) {
      warnings.push(
        `${key} ${out[key]} in flowctl.config.yaml is above the built-in ceiling; ${max} is used.`,
      );
      out[key] = max;
    }
  return { cfg: out, warnings };
}

const isCapped = (key: string): key is CappedKey =>
  Object.hasOwn(CEILINGS, key);
