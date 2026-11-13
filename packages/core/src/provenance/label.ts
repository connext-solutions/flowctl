import { claimsDerivation, type Flow } from '../flow/index.js';
import { TrustError, openTrustStore, type TrustStore } from '../trust/index.js';
import { provenanceState, type ProvenanceState } from './state.js';

/**
 * The provenance label of a flow for a run, reading the trust store the run reads: the injected one (a test seam,
 * ADR 0025 section 1) or the owner's default store.
 *
 * @remarks Labelling never fails a run, whatever goes wrong while it reads:
 *   - A store that cannot be opened (tampered, unreadable, unsupported platform) labels the flow as if there were no
 *     store, with the note `trust_store_unavailable`. A store problem that matters for consent still surfaces where
 *     consent is checked (`hooks_untrusted`, `env_not_allowed`).
 *   - Any other failure while classifying (an unreadable store section, a file that vanished) falls back to
 *     `unverified` for a flow that claims a derivation and `unclassified` for any other, with the note
 *     `classification_unreadable:<ErrorClass>` (the error's class name only, never its message or a path): both are labels that vouch for nothing.
 * @param flowsRoot absolute path of the flows folder.
 * @param store `'default'` for the owner's store.
 */
export function labelFlow(
  flow: Flow,
  flowsRoot: string,
  store: TrustStore | 'default',
): ProvenanceState {
  try {
    return label(flow, flowsRoot, store);
  } catch (e) {
    return {
      state: claimsDerivation(flow) ? 'unverified' : 'unclassified',
      notes: [
        'freshness_not_checked',
        'rollback_not_checked',
        `classification_unreadable:${errorClass(e)}`,
      ],
    };
  }
}

/** The class name of a thrown value, never its message or any path in it. */
function errorClass(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : typeof e;
  return /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : 'Unknown';
}

function label(
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
