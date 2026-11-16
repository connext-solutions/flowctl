import { randomInt } from 'node:crypto';
import dayjs from 'dayjs';
import type { Flow } from '../../flow/index.js';
import {
  ApprovalError,
  approvalsPath,
  authenticRecords,
  evidenceHash,
  flowContentHash,
  highestRevision,
  MAX_RECORDS,
  signatureHolds,
  type ApprovalPayload,
  type CaseApprovalRecord,
} from '../../provenance/index.js';
import {
  raiseLatestRevision,
  reviewerKeyStatus,
  storedRevisions,
  TrustError,
  TrustStore,
} from '../../trust/index.js';
import {
  assertionsOf,
  readExisting,
  refuseEarly,
  signedBytes,
  writeRecord,
} from './approve-steps.js';
import { boundBaseline, stringsIn, verifyBaseline } from './baseline.js';
import {
  confirmReplays,
  replayCount,
  resolveSources,
} from './confirm-replay.js';
import { pruneRecords } from './prune.js';
import { nextRevision } from './revision.js';
import { reviewScreen } from './screen.js';
import type {
  BaselineInput,
  NumberSpec,
  Replayer,
  Signer,
  SourceResolver,
  Tty,
} from './types.js';

/** What {@link approveCase} needs. The three seams (`tty`, `signer`, `replayer`) are built by the CLI (T4.8). */
export interface ApproveOptions {
  flow: Flow;
  /** The name of the store's `projects` entry that matched the checkout. */
  project: string;
  /** The trust store; `undefined` when none exists (`trust_missing`). */
  store: TrustStore | undefined;
  tty: Tty;
  signer: Signer;
  replayer: Replayer;
  resolver: SourceResolver;
  /** The AppMap slice the case rests on; hashed here, and its strings are what the map showed for a baseline. */
  appMapEvidence: unknown;
  /** Required exactly when the flow has a baseline assertion; `value` must be the value that assertion checks. */
  baseline?: BaselineInput;
  /** Per assertion (by index): the number it checks. */
  numbers?: readonly (NumberSpec | undefined)[];
  /** Confirming replays, 2 to 8; two by default, so one flaky pass does not sign. */
  replays?: number;
  now?: Date;
}

/** What a successful approval wrote. */
export interface ApprovalResult {
  record: CaseApprovalRecord;
  file: string;
  revision: number;
  /** Records `--prune` semantics removed first because the file was full. */
  pruned: number;
  /** Advice only: the owner-signed command that raises the floor to this revision. */
  floorCommand: string;
}

/**
 * Approves one flow: re-does the work in this process, shows what the verifier will check, asks for a nonce on the
 * terminal and signs a case-approval record with the reviewer's key (ADR 0020 sections f, j and k). The command
 * `flowctl review` is T4.8 and wires `/dev/tty`; nothing here is reachable over MCP.
 *
 * @remarks Order: refusals that touch nothing (no store, a `ci` store, no terminal, a replay count outside 2..8, a
 *   baseline that is not the flow's, an approvals file that cannot be read) first; then every `sourceRef` is
 *   re-resolved and the confirming replays run, ignoring any hash the generator holds; a baseline must be among the
 *   values those replays and the AppMap slice showed. The payload then passes the record schema before the screen
 *   (which refuses to cut a value), the nonce, the passphrase (echo off, from the terminal only) and the signature,
 *   which is checked under the public key the store holds. The record is written to `<flow>.approvals.json` first
 *   and `latestRevision` is raised second; if the second write fails the record exists unrecorded and the error says
 *   so. A full approvals file (256 records) keeps only its authentic records of the current hash first. The private
 *   key stays inside the signer: this function never reads, logs or returns key bytes or the passphrase.
 * @throws {TrustError} `trust_missing`, `tty_required`, `confirmation_mismatch`, and the key refusals of the signer.
 * @throws {ApprovalError} as its codes say; `latest_revision_unrecorded` after the record was written.
 */
export async function approveCase(o: ApproveOptions): Promise<ApprovalResult> {
  const store = refuseEarly(o);
  const { flow } = o;
  const count = replayCount(o.replays);
  const baseline = boundBaseline(flow, o.baseline);
  const file = readExisting(flow.file);
  await resolveSources(flow, o.resolver);
  const replays = await confirmReplays(flow, o.replayer, count);
  if (baseline !== undefined)
    verifyBaseline(baseline.value, [
      ...replays.seen,
      ...stringsIn(o.appMapEvidence),
    ]);
  const now = o.now ?? new Date();
  const fresh = TrustStore.open(store.dir);
  const flowHash = flowContentHash(flow);
  const ctx = { project: o.project, flow, flowHash, store: fresh, now };
  const full = file.records.length >= MAX_RECORDS;
  const kept = full ? pruneRecords(ctx, file.records) : file.records;
  const revision = nextRevision({
    ...storedRevisions(fresh, o.project, flow.name),
    h: highestRevision(authenticRecords(ctx, kept).records),
  });
  const numbers = o.numbers ?? [];
  const payloadFor = (keyId: string): ApprovalPayload => ({
    project: o.project,
    flowName: flow.name,
    flowHash,
    revision,
    keyId,
    approvedAt: dayjs(now).toISOString(),
    assertions: assertionsOf(flow, numbers),
    replayHashes: replays.hashes,
    evidenceHash: evidenceHash(o.appMapEvidence),
    ...(baseline === undefined
      ? {}
      : { baseline: { value: baseline.value, evidence: baseline.evidence } }),
  });
  signedBytes(payloadFor('0'.repeat(64)));
  o.tty.show(
    reviewScreen({
      flow,
      project: o.project,
      flowHash,
      revision,
      replays: count,
      numbers,
      ...(baseline === undefined ? {} : { baseline }),
    }),
  );
  await askNonce(o.tty);
  const signer = o.signer.unlock(
    await o.tty.askSecret('Reviewer key passphrase: '),
  );
  const { status, key } = reviewerKeyStatus(fresh, signer.keyId, 'flows', now);
  if (status !== 'valid' || key === undefined)
    throw new ApprovalError(
      'reviewer_key_invalid',
      `This key cannot approve flows here: ${status}.`,
    );
  const payload = payloadFor(signer.keyId);
  const record: CaseApprovalRecord = {
    v: 1,
    ...payload,
    signature: signer.sign(signedBytes(payload)),
  };
  if (!signatureHolds(record, key.publicKeyBytes))
    throw new ApprovalError(
      'payload_invalid',
      'The signature does not verify under the key the store holds; nothing was written.',
    );
  writeRecord(flow.file, file, kept, record);
  try {
    raiseLatestRevision(fresh, o.project, flow.name, revision);
  } catch (e) {
    throw new ApprovalError(
      'latest_revision_unrecorded',
      `The approval record exists in ${approvalsPath(flow.file)} but latestRevision was not raised${e instanceof TrustError ? ` (${e.kind})` : ''}; run review again.`,
    );
  }
  return {
    record,
    file: approvalsPath(flow.file),
    revision,
    pruned: file.records.length - kept.length,
    floorCommand: `flowctl trust add floor ${flow.name} ${revision}`,
  };
}

async function askNonce(tty: Tty): Promise<void> {
  const nonce = String(randomInt(100000, 1000000));
  const typed = await tty.ask(
    `Type ${nonce} to approve, anything else to stop: `,
  );
  if (typed.trim() !== nonce)
    throw new TrustError(
      'confirmation_mismatch',
      'Not approved; nothing was written.',
    );
}
