/**
 * The effective configuration (ADR 0024 section 1): the repo `flowctl.config.yaml` intersected with the trust store
 * and the built-in ceilings. Reading and parsing the file stays in `../config.ts`, which imports `TargetSchema` from
 * here; modules of this folder may import `../config.js` for types only, or the two would load in a cycle.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export { type CappedKey, CEILINGS, MIN_CONFIDENCE } from './ceilings.js';
export { type EffectiveConfig, effectiveConfig } from './effective.js';
export { type Target, TargetSchema } from './target-schema.js';
export {
  BUDGET_CEILINGS,
  type EnvCeiling,
  type EnvScope,
  narrowTarget,
} from './target.js';
