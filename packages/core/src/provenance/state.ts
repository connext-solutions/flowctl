import { claimsDerivation, type Flow } from '../flow/index.js';
import type { ProvenanceStateName } from '../foundation/index.js';
import {
  flowFileChanged,
  listedHandWritten,
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
 * @remarks This is the T0.11 stub: **it never returns `verified`**, because no verifier is installed yet (the signed
 *   case-approval record is T4.x). Precedence is `verified`, `hand-written`, `unverified`, `unclassified`; a flow
 *   that claims a derivation is never `hand-written`, even when the store lists its path. The notes always hold
 *   `freshness_not_checked` and `rollback_not_checked` (no floor is read), and `signature_unavailable` for a claim
 *   that no verifier can check. `hand-written` adds `handwritten_entry_unsigned`: the store's `handWritten` entries
 *   have no schema or per-entry signature check yet (T4.16), so the listing is only as trustworthy as the store file.
 *   A flow whose file changed after `loadFlow` read it is never `hand-written`: it is `unclassified` with
 *   `flow_file_changed`, so the label always describes the bytes the run uses. The label never changes a verdict
 *   (ADR 0004).
 * @param flowsRoot absolute path of the flows folder; the store's entries are keyed relative to it.
 * @param store the trust store, or `undefined` when there is none.
 */
export function provenanceState(
  flow: Flow,
  flowsRoot: string,
  store: ProvenanceStore | undefined,
): ProvenanceState {
  const notes = ['freshness_not_checked', 'rollback_not_checked'];
  if (claimsDerivation(flow))
    return { state: 'unverified', notes: [...notes, 'signature_unavailable'] };
  if (flowFileChanged(flow, flowsRoot))
    return { state: 'unclassified', notes: [...notes, 'flow_file_changed'] };
  const listed =
    store !== undefined && listedHandWritten(flow, flowsRoot, store);
  return listed
    ? { state: 'hand-written', notes: [...notes, 'handwritten_entry_unsigned'] }
    : { state: 'unclassified', notes };
}
