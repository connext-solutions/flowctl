import { basename } from 'node:path';
import type { Flow } from '../../flow/index.js';
import {
  ApprovalError,
  assertionHash,
  CaseApprovalRecordSchema,
  encodeApprovalPayload,
  readApprovals,
  upsertRecord,
  writeApprovals,
  type ApprovalPayload,
  type ApprovalsRead,
  type ApprovedAssertion,
  type CaseApprovalRecord,
} from '../../provenance/index.js';
import { TrustError, type TrustStore } from '../../trust/index.js';
import type { NumberSpec, Tty } from './types.js';

const stemOf = (file: string): string =>
  basename(file).replace(/\.ya?ml$/i, '');

/**
 * The refusals that touch nothing: no store, a `ci` store, no terminal, a flow not on disk or not named after its file.
 *
 * @returns the store.
 */
export function refuseEarly(o: {
  store: TrustStore | undefined;
  tty: Tty;
  flow: Flow;
}): TrustStore {
  if (o.store === undefined)
    throw new TrustError(
      'trust_missing',
      'No trust store. Run: flowctl trust init',
    );
  if (o.store.isCi)
    throw new ApprovalError(
      'review_refused_on_ci_store',
      'This trust store is marked ci; approvals happen on the owner machine.',
    );
  if (!o.tty.interactive)
    throw new TrustError(
      'tty_required',
      'Review needs an interactive terminal and reads nothing from a pipe, an environment variable or an argument.',
    );
  if (o.flow.file === '')
    throw new ApprovalError(
      'flow_not_on_disk',
      'Only a flow saved as a file can be approved.',
    );
  if (stemOf(o.flow.file) !== o.flow.name)
    throw new ApprovalError(
      'flow_name_mismatch',
      'The flow name is not its file name.',
    );
  return o.store;
}

/**
 * The flow's approvals file as it is now. A full file (`approvals_too_large`) is fine, it is pruned; any other
 * problem (not JSON, merge conflict markers, a symlink, over 1 MiB, unreadable) is refused, so an approval never
 * replaces a file nobody could read.
 *
 * @throws {ApprovalError} `approvals_unreadable`.
 */
export function readExisting(flowFile: string): ApprovalsRead {
  const file = readApprovals(flowFile);
  if (file.notes.some((n) => n !== 'approvals_too_large'))
    throw new ApprovalError(
      'approvals_unreadable',
      `The approvals file of this flow cannot be read (${file.notes.join(', ')}); fix or remove it, then review again.`,
    );
  return file;
}

/** The approved assertions of `flow`: each hash, its `sourceRef`, the fixed polarity `positive` and its number. */
export function assertionsOf(
  flow: Flow,
  numbers: readonly (NumberSpec | undefined)[],
): ApprovedAssertion[] {
  return flow.assertions.map((a, i) => ({
    hash: assertionHash(a),
    ...(a.sourceRef === undefined ? {} : { sourceRef: a.sourceRef }),
    polarity: 'positive' as const,
    ...(numbers[i] === undefined ? {} : { number: numbers[i] }),
  }));
}

const PayloadSchema = CaseApprovalRecordSchema.omit({ signature: true });

const invalid = (where: string): ApprovalError =>
  new ApprovalError(
    'payload_invalid',
    `The approval would break the record schema at ${where}; nothing was signed.`,
  );

/**
 * The bytes to sign for `payload`, after the record schema accepted it (the same limits the verifier reads with: at
 * most 200 assertions, 8 replay hashes, a baseline value of 500 and evidence of 2000 characters, a number label of
 * 100) and the encoder did.
 *
 * @throws {ApprovalError} `payload_invalid`; the message names the field path, never a value.
 */
export function signedBytes(payload: ApprovalPayload): Buffer {
  const parsed = PayloadSchema.safeParse({ v: 1, ...payload });
  if (!parsed.success)
    throw invalid(parsed.error.issues[0]?.path.join('.') ?? 'the record');
  return encodeApprovalPayload(payload);
}

/**
 * Checks the signed record against the full schema, then writes it into the approvals file, replacing an older
 * record of the same key and hash. The file is read again first and must hold what the review read at its start.
 *
 * @remarks No lock covers the approvals file: two reviews of one flow at the same moment can still both pass the
 *   re-read, and the later write wins (ADR 0042 section 5).
 * @throws {ApprovalError} `payload_invalid`; `approvals_changed` when the file changed during the review.
 */
export function writeRecord(
  flowFile: string,
  before: ApprovalsRead,
  kept: readonly unknown[],
  record: CaseApprovalRecord,
): void {
  if (!CaseApprovalRecordSchema.safeParse(record).success)
    throw invalid('the signed record');
  const now = readApprovals(flowFile);
  if (JSON.stringify(now) !== JSON.stringify(before))
    throw new ApprovalError(
      'approvals_changed',
      'The approvals file changed during the review; nothing was written. Review again.',
    );
  writeApprovals(flowFile, upsertRecord(kept, record));
}
