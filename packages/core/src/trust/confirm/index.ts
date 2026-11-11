/**
 * Stored destructive confirmations (ADR 0024 section 5 and its amendment 2026-11-12 "destructive ledger details"):
 * the `destructiveConfirm` entry schema and rules, the confirmation digest, and reading, writing and revoking
 * owner-signed entries. The request layer that applies them and the run ledger come with T1.3 step 3.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export { confirmLine } from './display.js';
export {
  type ConfirmDigestInput,
  type ConfirmPlan,
  planConfirm,
} from './digest.js';
export {
  type ConfirmRead,
  readConfirmEntries,
  type ReadContext,
  revokeConfirmEntry,
  saveConfirmEntries,
} from './entry.js';
export {
  type IdPosition,
  literalPrefix,
  parseIdPosition,
  parsePointer,
  parseTemplate,
  type Segment,
} from './grammar.js';
export { latestExpiry, MAX_DAYS, utcDate } from './rules.js';
export {
  type ConfirmEntry,
  ConfirmEntrySchema,
  type CreateConfirm,
  type MutateConfirm,
} from './schema.js';
