import type { Flow } from '../../flow/index.js';
import { ApprovalError, flowBaseline } from '../../provenance/index.js';
import type { BaselineInput } from './types.js';

/**
 * The approval-time check of a baseline (ADR 0020 section f): the approved value must be one the replay evidence and
 * the AppMap actually showed, so a reviewer cannot sign a value nothing observed. Compared after NFC; no fuzzy match.
 *
 * @param observed what the review's own replays reported (`baselineSeen`) and the strings of the AppMap slice.
 * @throws {ApprovalError} `baseline_mismatch`.
 */
export function verifyBaseline(
  value: string,
  observed: readonly string[],
): void {
  const want = value.normalize('NFC');
  if (!observed.some((o) => o.normalize('NFC') === want))
    throw new ApprovalError(
      'baseline_mismatch',
      'The approved baseline value is not among the values the replays and the map showed.',
    );
}

/**
 * Binds the baseline to approve to the flow (ADR 0042 section 5): a flow whose assertion has a `baseline` sourceRef
 * needs `input`, whose value must be exactly the value that assertion checks; a flow with none takes none.
 *
 * @returns `input` when the flow has a baseline, else `undefined`.
 * @throws {ApprovalError} `baseline_required` with no input for a baseline flow; `baseline_mismatch` for a value
 *   the flow does not check, or a baseline for a flow that asserts none; `baseline_unsupported` for more than one
 *   baseline assertion or one that checks no single value.
 */
export function boundBaseline(
  flow: Flow,
  input: BaselineInput | undefined,
): BaselineInput | undefined {
  const want = flowBaseline(flow);
  if (want.kind === 'unsupported')
    throw new ApprovalError(
      'baseline_unsupported',
      'A flow can approve one baseline assertion, of kind text, url or value.',
    );
  if (want.kind === 'none') {
    if (input === undefined) return undefined;
    throw new ApprovalError(
      'baseline_mismatch',
      'The flow has no baseline assertion, so there is no baseline to approve.',
    );
  }
  if (input === undefined)
    throw new ApprovalError(
      'baseline_required',
      'The flow has a baseline assertion; approving it needs the baseline value and evidence.',
    );
  if (input.value !== want.value)
    throw new ApprovalError(
      'baseline_mismatch',
      'The baseline value to approve is not the value the flow asserts.',
    );
  return input;
}

const MAX_DEPTH = 64;
const MAX_STRINGS = 100_000;

/**
 * Every string in `slice` (the AppMap evidence the case rests on), depth first, at most 64 levels deep and 100 000
 * strings: the map's half of what a baseline may be compared with.
 */
export function stringsIn(slice: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, depth: number): void => {
    if (out.length >= MAX_STRINGS || depth > MAX_DEPTH) return;
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) for (const x of v) walk(x, depth + 1);
    else if (typeof v === 'object' && v !== null)
      for (const x of Object.values(v)) walk(x, depth + 1);
  };
  walk(slice, 0);
  return out;
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
