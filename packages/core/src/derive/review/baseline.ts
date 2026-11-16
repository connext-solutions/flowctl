import { ApprovalError } from '../../provenance/index.js';
import type { BaselineInput } from './types.js';

/**
 * The approval-time check of a baseline (ADR 0020 section f): the approved value must be one the replay evidence and
 * the AppMap actually showed, so a reviewer cannot sign a value nothing observed. Compared after NFC; no fuzzy match.
 *
 * @throws {ApprovalError} `baseline_mismatch`.
 */
export function verifyBaseline(baseline: BaselineInput): void {
  const want = baseline.value.normalize('NFC');
  if (!baseline.observed.some((o) => o.normalize('NFC') === want))
    throw new ApprovalError(
      'baseline_mismatch',
      'The approved baseline value is not among the values the replays and the map showed.',
    );
}

/**
 * Refuses generator output that already carries a `baseline` reference or an approval record: only a review adds
 * either (ADR 0020 section f: such output is rejected, and reports count baselines separately).
 *
 * @throws {ApprovalError} `baseline_pre_approved`.
 */
export function rejectPreApproved(output: {
  assertions: readonly { sourceRef?: { kind: string } }[];
  approvals?: readonly unknown[];
}): void {
  if (
    (output.approvals?.length ?? 0) > 0 ||
    output.assertions.some((a) => a.sourceRef?.kind === 'baseline')
  )
    throw new ApprovalError(
      'baseline_pre_approved',
      'Generator output carries a baseline reference or an approval record; only a review adds one.',
    );
}

/** How many assertions of `flow` are baselines: reports count them apart from spec-derived ones. */
export const baselineCount = (flow: {
  assertions: readonly { sourceRef?: { kind: string } }[];
}): number =>
  flow.assertions.filter((a) => a.sourceRef?.kind === 'baseline').length;
