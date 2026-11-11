/**
 * Free checks (task T2.4): verdicts from an `AppMap` alone, each finding with an `invariant` sourceRef and the map
 * entry it stands on.
 */
export { freeChecks } from './rules.js';
export {
  CHECK_IDS,
  CheckFindingSchema,
  CheckResultSchema,
  FreeChecksSchema,
  MAX_FINDINGS,
  type CheckFinding,
  type CheckId,
  type CheckResult,
  type FreeChecks,
} from './schema.js';
