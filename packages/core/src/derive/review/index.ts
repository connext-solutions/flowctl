/**
 * The review gate (T4.5, ADR 0020 sections f, j, k; ADR 0042): `approveCase` signs a case-approval record after the
 * review process re-resolved every source, re-ran the confirming replays and got the reviewer's nonce on a terminal.
 * The command `flowctl review` is T4.8; this folder takes the terminal, the signer and the replayer as seams. Not
 * exported from the package, and never an MCP tool.
 */
export {
  approveCase,
  type ApprovalResult,
  type ApproveOptions,
} from './approve.js';
export {
  baselineCount,
  rejectPreApproved,
  verifyBaseline,
} from './baseline.js';
export { confirmReplays, resolveSources } from './confirm-replay.js';
export { pruneApprovals, pruneRecords } from './prune.js';
export { nextRevision } from './revision.js';
export { operatorOf, reviewScreen, type ScreenInput } from './screen.js';
export type {
  BaselineInput,
  NumberSpec,
  ReplayEvidence,
  Replayer,
  Signer,
  SourceResolver,
  Tty,
} from './types.js';
