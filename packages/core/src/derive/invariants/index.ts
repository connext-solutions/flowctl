/**
 * The invariant library (task T4.9, ADR 0041): ten parameterised templates that bind to evidence, judge what was
 * observed and, where the assertion schema allows, expand to a flow assertion that `invariantResolves` can re-check.
 * No model.
 */
export {
  DRIVE_ACTIONS,
  DRIVE_POINTER,
  DRIVE_VALUE_PREFIX,
  DriveRecordSchema,
  DriveStepSchema,
  InvariantEvidenceSchema,
  type DriveRecord,
  type DriveStep,
  type Evidence,
  type InvariantEvidence,
} from './evidence.js';
export {
  INVARIANTS,
  evaluateInvariant,
  expandInvariant,
  isInvariantId,
  isSmokeOnly,
} from './registry.js';
export { invariantResolves, type Resolution } from './resolve.js';
export {
  INVARIANT_IDS,
  type Binding,
  type Evaluation,
  type Expansion,
  type InvariantFinding,
  type InvariantId,
  type InvariantTemplate,
  type Observation,
  type Refusal,
  type RefusalReason,
} from './types.js';
