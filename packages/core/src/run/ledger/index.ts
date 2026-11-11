/**
 * The run ledger of a replay on a `shared` env (ADR 0024 section 5 and its amendment 2026-11-12 "destructive ledger
 * details"): authorising writes against stored `destructiveConfirm` entries, the seen-set of id-shaped tokens, the
 * ids a run created, and their cleanup at the end of the run and in `flowctl cleanup`.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export {
  CLEANUP_TIMING,
  cleanIds,
  type CleanupTarget,
  type CleanupTiming,
  fillTemplate,
  type Send,
} from './cleanup.js';
export { cleanupRun, ledgerState, type LedgerState } from './cleanup-run.js';
export { confirmInputFor, confirmReadContext } from './context.js';
export { type LedgerOptions, RunLedger } from './run-ledger.js';
export {
  currentDigest,
  type DestructivePlan,
  planDestructive,
  planRenew,
  type Renewal,
} from './plan-add.js';
export { readRecordedRun, type RecordedRun } from './recorded.js';
export {
  idTokens,
  MAX_BODY_BYTES,
  MAX_IDS,
  MAX_SEEN,
  MAX_TEXT_BYTES,
  SeenSet,
} from './seen.js';
