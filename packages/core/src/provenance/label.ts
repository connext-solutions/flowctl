import { existsSync } from 'node:fs';
import { claimsDerivation, type Flow } from '../flow/index.js';
import {
  TrustError,
  openTrustStore,
  projectFor,
  type TrustStore,
} from '../trust/index.js';
import type { VerifyOptions } from './approval-state.js';
import { approvalsPath } from './approvals-file.js';
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
 * @param options `projectRoot` (the checkout, to find the store's project entry) turns on the signature checks of
 *   `verified`; without it a claim stays `unverified`. A checkout the store does not know, or whose identity cannot be
 *   checked, is `unverified` with `project_not_registered` or `project_unresolved:<kind>`.
 */
export function labelFlow(
  flow: Flow,
  flowsRoot: string,
  store: TrustStore | 'default',
  options: LabelOptions = {},
): ProvenanceState {
  try {
    return label(flow, flowsRoot, store, options);
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
  try {
    if (!(e instanceof Error)) return 'Unknown';
    const name: unknown = e.constructor.name;
    return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)
      ? name
      : 'Unknown';
  } catch {
    return 'Unknown';
  }
}

/** What {@link labelFlow} may be told beyond the flow and the store. */
export interface LabelOptions {
  projectRoot?: string;
  now?: Date;
  mergeBaseRevision?: number;
  hasDuplicateStem?: boolean;
}

function verifyOptions(
  flow: Flow,
  store: TrustStore,
  o: LabelOptions,
): { verify?: VerifyOptions; note?: string } {
  if (o.projectRoot === undefined) return {};
  const hasRecord = flow.file !== '' && existsSync(approvalsPath(flow.file));
  if (!claimsDerivation(flow) && !hasRecord) return {};
  let project: string | undefined;
  try {
    project = projectFor(store, o.projectRoot);
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    return { note: `project_unresolved:${e.kind}` };
  }
  if (project === undefined) return { note: 'project_not_registered' };
  return {
    verify: {
      project,
      store,
      ...(o.now === undefined ? {} : { now: o.now }),
      ...(o.mergeBaseRevision === undefined
        ? {}
        : { mergeBaseRevision: o.mergeBaseRevision }),
      ...(o.hasDuplicateStem === undefined
        ? {}
        : { hasDuplicateStem: o.hasDuplicateStem }),
    },
  };
}

function label(
  flow: Flow,
  flowsRoot: string,
  store: TrustStore | 'default',
  options: LabelOptions,
): ProvenanceState {
  let opened: TrustStore | undefined;
  try {
    opened = store === 'default' ? openTrustStore() : store;
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    const r = provenanceState(flow, flowsRoot, undefined);
    return { ...r, notes: [...r.notes, 'trust_store_unavailable'] };
  }
  if (opened === undefined) return provenanceState(flow, flowsRoot, undefined);
  const { verify, note } = verifyOptions(flow, opened, options);
  const r = provenanceState(flow, flowsRoot, opened, verify);
  return note === undefined ? r : { ...r, notes: [...r.notes, note] };
}
