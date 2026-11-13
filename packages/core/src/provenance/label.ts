import type { Flow } from '../flow/index.js';
import { TrustError, openTrustStore, type TrustStore } from '../trust/index.js';
import { provenanceState, type ProvenanceState } from './state.js';

/**
 * The provenance label of a flow for a run, reading the trust store the run reads: the injected one (a test seam,
 * ADR 0025 section 1) or the owner's default store.
 *
 * @remarks A store that cannot be opened (tampered, unreadable, unsupported platform) never fails the run: the flow
 *   is labelled as if there were no store, with the note `trust_store_unavailable`, so a flow that claims a
 *   derivation stays `unverified` and any other is `unclassified`. A store problem that matters for consent still
 *   surfaces where consent is checked (`hooks_untrusted`, `env_not_allowed`).
 * @param flowsRoot absolute path of the flows folder.
 * @param store `'default'` for the owner's store.
 */
export function labelFlow(
  flow: Flow,
  flowsRoot: string,
  store: TrustStore | 'default',
): ProvenanceState {
  let opened: TrustStore | undefined;
  try {
    opened = store === 'default' ? openTrustStore() : store;
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    const r = provenanceState(flow, flowsRoot, undefined);
    return { ...r, notes: [...r.notes, 'trust_store_unavailable'] };
  }
  return provenanceState(flow, flowsRoot, opened);
}
