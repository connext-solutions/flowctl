import { ApprovalError } from '../../provenance/index.js';
import { MAX_REVISION } from '../../trust/index.js';

/**
 * The revision a new approval gets: `max(latestRevision, flowFloors, H) + 1`, each missing value counting as 0
 * (ADR 0020 Amendment 2026-11-02 section j, rule 3). `H` is the highest revision among the authentic records of the
 * current (project, flow name).
 *
 * @throws {ApprovalError} `revision_overflow` above 2^53-1.
 */
export function nextRevision(v: {
  latest?: number;
  floor?: number;
  h: number;
}): number {
  const next = Math.max(v.latest ?? 0, v.floor ?? 0, v.h) + 1;
  if (next > MAX_REVISION)
    throw new ApprovalError(
      'revision_overflow',
      'The next revision would exceed 9007199254740991.',
    );
  return next;
}
