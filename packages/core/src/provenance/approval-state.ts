import { basename } from 'node:path';
import type { Flow } from '../flow/index.js';
import { storedRevisions, type TrustStore } from '../trust/index.js';
import { readApprovals } from './approvals-file.js';
import { flowContentHash } from './flow-hash.js';
import { requiredRevision } from './required-revision.js';
import { verifyApprovals } from './verify.js';

/** What verifying a flow's approval records needs beyond the flow (ADR 0020 section h: the cheap checks only). */
export interface VerifyOptions {
  /** The name of the store's `projects` entry that matched the checkout. */
  project: string;
  store: TrustStore;
  /** The clock for key expiry; now when left out. */
  now?: Date;
  /** The highest revision at the merge base, resolved by the caller (`provenance/` never spawns git). */
  mergeBaseRevision?: number;
  /** True when another flow file under the flows root has this stem and claims a derivation (Amendment 2026-11-02 section j, rule 2). */
  hasDuplicateStem?: boolean;
}

/** The result of the cheap checks: whether a record verifies, and the reason codes. */
export interface ApprovalCheck {
  verified: boolean;
  notes: string[];
}

const stemOf = (file: string): string =>
  basename(file).replace(/\.ya?ml$/i, '');

/**
 * Whether the flow's `<flow>.approvals.json` verifies against the store: a flow whose name is not its file stem
 * (`flow_name_mismatch`) or whose stem another claiming flow shares (`flow_name_duplicate`) is not verified; so is a
 * file with more than 256 records; otherwise {@link verifyApprovals} with the required revision of the store's floor and
 * latest revision and the caller's merge-base value. `rollback_not_checked` is a note when all three are absent. No record at all is
 * `signature_unavailable`.
 *
 * @throws {TrustError} `trust_tampered` for a damaged `reviewerKeys`, `flowFloors` or `latestRevision`.
 */
export function checkApprovals(
  flow: Flow,
  options: VerifyOptions,
): ApprovalCheck {
  if (flow.file === '')
    return { verified: false, notes: ['signature_unavailable'] };
  if (flow.name !== stemOf(flow.file))
    return { verified: false, notes: ['flow_name_mismatch'] };
  if (options.hasDuplicateStem === true)
    return { verified: false, notes: ['flow_name_duplicate'] };
  const file = readApprovals(flow.file);
  if (file.tooLarge) return { verified: false, notes: file.notes };
  if (file.records.length === 0)
    return {
      verified: false,
      notes: [...file.notes, 'signature_unavailable'],
    };
  const stored = storedRevisions(options.store, options.project, flow.name);
  const { required, rollbackNotChecked } = requiredRevision({
    ...stored,
    ...(options.mergeBaseRevision === undefined
      ? {}
      : { mergeBase: options.mergeBaseRevision }),
  });
  const verdict = verifyApprovals(
    {
      project: options.project,
      flow,
      flowHash: flowContentHash(flow),
      store: options.store,
      now: options.now ?? new Date(),
    },
    file.records,
    required,
  );
  const notes = [...file.notes, ...verdict.notes];
  if (verdict.verified && rollbackNotChecked)
    notes.push('rollback_not_checked');
  return { verified: verdict.verified, notes };
}
