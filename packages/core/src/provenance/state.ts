import { claimsDerivation, type Flow } from '../flow/index.js';
import type { ProvenanceStateName } from '../foundation/index.js';
import { existsSync } from 'node:fs';
import { checkApprovals, type VerifyOptions } from './approval-state.js';
import { approvalsPath } from './approvals-file.js';
import {
  flowFileChanged,
  flowFileUnreadable,
  listedHandWritten,
  snapshotFlowFile,
  type ProvenanceStore,
} from './hand-written.js';

/** A flow's provenance label and the notes that qualify it (`run.json` `provenance` and `provenanceNotes`). */
export interface ProvenanceState {
  state: ProvenanceStateName;
  notes: string[];
}

/**
 * Classifies a flow for a run (ADR 0020 sections b and h): `hand-written` when it claims nothing and the store lists
 * its path and closure digest, `unverified` when it claims a derivation (`derived` or a `sourceRef`), else
 * `unclassified`.
 *
 * @remarks `verified` is reachable only when `verify` is given (the store and the project name) and a signed
 *   case-approval record passes the cheap checks of `checkApprovals` (T4.5); without `verify` the function behaves
 *   as the T0.11 stub and never returns `verified`. Precedence is `verified`, `hand-written`, `unverified`,
 *   `unclassified`; a flow that claims a derivation is never `hand-written`, even when the store lists its path. The
 *   notes always hold `freshness_not_checked`; `rollback_not_checked` unless a floor, a latest revision or a merge-base
 *   value applies; `signature_unavailable` for a claim with no record or no verifier. `hand-written` adds `handwritten_entry_unsigned`: the store's `handWritten` entries
 *   have no schema or per-entry signature check yet (T4.16), so the listing is only as trustworthy as the store file.
 *   A flow whose file changed after `loadFlow` read it is never `hand-written`: it is `unclassified` with
 *   `flow_file_changed`, so the label always describes the bytes the run uses. A file that cannot be hashed (over 256 KiB, a hard link, a
 *   symlink) is `unclassified` with `flow_file_unreadable`: the label cannot tell whether it matches. The label never changes a verdict
 *   (ADR 0004).
 * @param flowsRoot absolute path of the flows folder; the store's entries are keyed relative to it.
 * @param store the trust store, or `undefined` when there is none.
 * @param verify what the verifier needs; without it a claim stays `unverified`.
 */
export function provenanceState(
  flow: Flow,
  flowsRoot: string,
  store: ProvenanceStore | undefined,
  verify?: VerifyOptions,
): ProvenanceState {
  const notes = ['freshness_not_checked', 'rollback_not_checked'];
  const hasRecord = flow.file !== '' && existsSync(approvalsPath(flow.file));
  if (verify !== undefined && (claimsDerivation(flow) || hasRecord)) {
    const check = checkApprovals(flow, verify);
    return {
      state: check.verified ? 'verified' : 'unverified',
      notes: ['freshness_not_checked', ...check.notes],
    };
  }
  if (claimsDerivation(flow))
    return { state: 'unverified', notes: [...notes, 'signature_unavailable'] };
  const snapshot = snapshotFlowFile(flow, flowsRoot);
  if (flowFileChanged(flow, flowsRoot, snapshot))
    return { state: 'unclassified', notes: [...notes, 'flow_file_changed'] };
  if (flowFileUnreadable(flow, flowsRoot, snapshot))
    return { state: 'unclassified', notes: [...notes, 'flow_file_unreadable'] };
  const listed =
    store !== undefined && listedHandWritten(flow, flowsRoot, store, snapshot);
  return listed
    ? { state: 'hand-written', notes: [...notes, 'handwritten_entry_unsigned'] }
    : { state: 'unclassified', notes };
}
