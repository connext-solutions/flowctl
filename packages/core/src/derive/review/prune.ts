import type { Flow } from '../../flow/index.js';
import {
  CaseApprovalRecordSchema,
  flowContentHash,
  readApprovals,
  writeApprovals,
} from '../../provenance/index.js';
import { reviewerKeyStatus, type TrustStore } from '../../trust/index.js';

/**
 * `review <flow> --prune` (ADR 0020 Amendment 2026-11-02 section j, rule 3): drops every record whose key is revoked,
 * expired, unknown or not of scope `flows`, whose content hash is not the current one, or that does not parse, and
 * keeps the rest as they are. It signs nothing and writes no store value.
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

/** The records of `raw` that {@link pruneApprovals} keeps; pure. */
export function pruneRecords(
  options: { flow: Flow; project: string; store: TrustStore; now?: Date },
  raw: readonly unknown[],
): unknown[] {
  const hash = flowContentHash(options.flow);
  const now = options.now ?? new Date();
  return raw.filter((element) => {
    const parsed = CaseApprovalRecordSchema.safeParse(element);
    if (!parsed.success) return false;
    const r = parsed.data;
    return (
      r.flowHash === hash &&
      r.project === options.project &&
      r.flowName === options.flow.name &&
      reviewerKeyStatus(options.store, r.keyId, 'flows', now).status === 'valid'
    );
  });
}
