/**
 * Provenance of a flow: whether its expected values come from a person, from a generator, or from nowhere known
 * (ADR 0020). Sits above `run/`: `replay.ts` computes the state and hands it to `RunSession` as an option.
 */
export {
  flowFileChanged,
  flowFileUnreadable,
  flowKey,
  handWrittenDigest,
  listedHandWritten,
  snapshotFlowFile,
  type FlowFileSnapshot,
  type ProvenanceStore,
} from './hand-written.js';
export { provenanceState, type ProvenanceState } from './state.js';
export { labelFlow, type LabelOptions } from './label.js';
export {
  checkApprovals,
  type ApprovalCheck,
  type VerifyOptions,
} from './approval-state.js';
export { ApprovalError, type ApprovalErrorCode } from './errors.js';
export {
  ApprovedAssertionSchema,
  CaseApprovalRecordSchema,
  type ApprovedAssertion,
  type CaseApprovalRecord,
} from './record.js';
export {
  APPROVAL_DOMAIN,
  encodeApprovalPayload,
  payloadOf,
  type ApprovalPayload,
} from './payload.js';
export { assertionHash, evidenceHash, flowContentHash } from './flow-hash.js';
export { flowBaseline, type FlowBaseline } from './baseline.js';
export {
  approvalsPath,
  MAX_RECORDS,
  readApprovals,
  upsertRecord,
  writeApprovals,
  type ApprovalsRead,
} from './approvals-file.js';
export {
  authenticRecords,
  highestRevision,
  signatureHolds,
  verifyApprovals,
  type ApprovalVerdict,
  type VerifyContext,
} from './verify.js';
export { requiredRevision, type RevisionSources } from './required-revision.js';
