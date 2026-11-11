/**
 * Stored destructive confirmations (ADR 0024 section 5 and its amendment 2026-11-12 "destructive ledger details"):
 * the `destructiveConfirm` entry schema and rules, the confirmation digest, and reading, writing and revoking
 * owner-signed entries, and matching a request against them (strict body reading, exact templates, headers). The
 * run ledger that binds ids is in `run/ledger/`; its file is `trust/ledger-file.ts`.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export { confirmLine } from './display.js';
export {
  type ConfirmDigestInput,
  type ConfirmFile,
  confirmFiles,
  type ConfirmPlan,
  planConfirm,
} from './digest.js';
export {
  type Draft,
  type EntryBase,
  entryOf,
  proposeDrafts,
  type RecordedCall,
  type RecordedWrite,
  recordedWrites,
} from './derive.js';
export {
  type ConfirmRead,
  readConfirmEntries,
  type ReadContext,
  renewConfirmEntries,
  revokeConfirmEntry,
  saveConfirmEntries,
  storedConfirmEntries,
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
  escapeSegment,
  type Leaf,
  leavesOf,
  parseStrictJson,
  readBody,
} from './body.js';
export {
  canonicalId,
  idValues,
  matchEntry,
  type Matched,
  MAX_BULK,
  stringAt,
  type WireRequest,
} from './match.js';
export {
  type ConfirmEntry,
  ConfirmEntrySchema,
  type CreateConfirm,
  type MutateConfirm,
} from './schema.js';
