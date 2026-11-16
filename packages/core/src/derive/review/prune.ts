import type { Flow } from '../../flow/index.js';
import {
  authenticRecords,
  flowContentHash,
  readApprovals,
  writeApprovals,
  type CaseApprovalRecord,
} from '../../provenance/index.js';
import type { TrustStore } from '../../trust/index.js';

/**
 * `review <flow> --prune` (ADR 0020 Amendment 2026-11-02 section j, rule 3): keeps only the authentic records
 * (`authenticRecords`: they parse, their revision is in range, their key is a live `flows` key, their signature
 * verifies, their `project` and `flowName` are the current ones) whose content hash is the current one, and drops
 * the rest, forged records of a valid key id included. It signs nothing and writes no store value.
 *
 * @returns how many records were removed and how many remain; the file is only rewritten when something was removed.
 * @throws {TrustError} `trust_tampered` for a damaged `reviewerKeys` section.
 */
export function pruneApprovals(options: {
  flow: Flow;
  project: string;
  store: TrustStore;
  now?: Date;
}): { removed: number; kept: number } {
  const { records } = readApprovals(options.flow.file);
  const kept = pruneRecords(options, records);
  if (kept.length !== records.length) writeApprovals(options.flow.file, kept);
  return { removed: records.length - kept.length, kept: kept.length };
}

/** The records of `raw` that {@link pruneApprovals} keeps; writes nothing. */
export function pruneRecords(
  options: { flow: Flow; project: string; store: TrustStore; now?: Date },
  raw: readonly unknown[],
): CaseApprovalRecord[] {
  const flowHash = flowContentHash(options.flow);
  const ctx = {
    project: options.project,
    flow: options.flow,
    flowHash,
    store: options.store,
    now: options.now ?? new Date(),
  };
  return authenticRecords(ctx, raw).records.filter(
    (r) => r.flowHash === flowHash,
  );
}
