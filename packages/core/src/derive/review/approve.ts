import { randomInt } from 'node:crypto';
import { basename } from 'node:path';
import dayjs from 'dayjs';
import type { Flow } from '../../flow/index.js';
import {
  ApprovalError,
  approvalsPath,
  assertionHash,
  authenticRecords,
  encodeApprovalPayload,
  evidenceHash,
  flowContentHash,
  highestRevision,
  MAX_RECORDS,
  readApprovals,
  signatureHolds,
  upsertRecord,
  writeApprovals,
  type ApprovedAssertion,
  type CaseApprovalRecord,
} from '../../provenance/index.js';
import {
  raiseLatestRevision,
  reviewerKeyStatus,
  storedRevisions,
  TrustError,
  TrustStore,
} from '../../trust/index.js';
import { verifyBaseline } from './baseline.js';
import { confirmReplays, resolveSources } from './confirm-replay.js';
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
  /** The AppMap slice the case rests on; hashed here. */
  appMapEvidence: unknown;
  baseline?: BaselineInput;
  /** Per assertion (by index): the number it checks. */
  numbers?: readonly (NumberSpec | undefined)[];
  /** Confirming replays; two by default, so a flaky pass does not sign. */
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

const stemOf = (file: string): string =>
  basename(file).replace(/\.ya?ml$/i, '');

function refuseEarly(o: ApproveOptions): TrustStore {
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

function assertionsOf(
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

/**
 * Approves one flow: re-does the work in this process, shows what the verifier will check, asks for a nonce on the
 * terminal and signs a case-approval record with the reviewer's key (ADR 0020 sections f, j and k). The command
 * `flowctl review` is T4.8 and wires `/dev/tty`; nothing here is reachable over MCP.
 *
 * @remarks Order: refusals that touch nothing (no store, a `ci` store, no terminal) first; then every `sourceRef` is
 *   re-resolved and the confirming replays run, ignoring any hash the generator holds; then the screen, the nonce, the
 *   passphrase (echo off, from the terminal only) and the signature. The record is written to `<flow>.approvals.json`
 *   first and `latestRevision` is raised second; if the second write fails the record exists unrecorded and the error
 *   says so. A full approvals file (256 records) is pruned first. The private key stays inside the signer: this
 *   function never reads, logs or returns key bytes or the passphrase.
 * @throws {TrustError} `trust_missing`, `tty_required`, `confirmation_mismatch`, and the key refusals of the signer.
 * @throws {ApprovalError} as its codes say; `latest_revision_unrecorded` after the record was written.
 */
export async function approveCase(o: ApproveOptions): Promise<ApprovalResult> {
  const store = refuseEarly(o);
  const { flow } = o;
  await resolveSources(flow, o.resolver);
  const count = o.replays ?? 2;
  const replayHashes = await confirmReplays(flow, o.replayer, count);
  if (o.baseline !== undefined) verifyBaseline(o.baseline);
  const now = o.now ?? new Date();
  const fresh = TrustStore.open(store.dir);
  const flowHash = flowContentHash(flow);
  const ctx = { project: o.project, flow, flowHash, store: fresh, now };
  const file = readApprovals(flow.file);
  const full = file.records.length >= MAX_RECORDS;
  const existing = full ? pruneRecords(ctx, file.records) : file.records;
  const stored = storedRevisions(fresh, o.project, flow.name);
  const revision = nextRevision({
    ...stored,
    h: highestRevision(authenticRecords(ctx, existing).records),
  });
  const numbers = o.numbers ?? [];
  o.tty.show(
    reviewScreen({
      flow,
      project: o.project,
      flowHash,
      revision,
      replays: count,
      numbers,
      ...(o.baseline === undefined ? {} : { baseline: o.baseline }),
    }),
  );
  const nonce = String(randomInt(100000, 1000000));
  const typed = await o.tty.ask(
    `Type ${nonce} to approve, anything else to stop: `,
  );
  if (typed.trim() !== nonce)
    throw new TrustError(
      'confirmation_mismatch',
      'Not approved; nothing was written.',
    );
  const signer = o.signer.unlock(
    await o.tty.askSecret('Reviewer key passphrase: '),
  );
  const status = reviewerKeyStatus(fresh, signer.keyId, 'flows', now);
  if (status.status !== 'valid')
    throw new ApprovalError(
      'reviewer_key_invalid',
      `This key cannot approve flows here: ${status.status}.`,
    );
  const payload = {
    project: o.project,
    flowName: flow.name,
    flowHash,
    revision,
    keyId: signer.keyId,
    approvedAt: dayjs(now).toISOString(),
    assertions: assertionsOf(flow, numbers),
    replayHashes,
    evidenceHash: evidenceHash(o.appMapEvidence),
    ...(o.baseline === undefined
      ? {}
      : {
          baseline: { value: o.baseline.value, evidence: o.baseline.evidence },
        }),
  };
  const record: CaseApprovalRecord = {
    v: 1,
    ...payload,
    signature: signer.sign(encodeApprovalPayload(payload)),
  };
  if (!signatureHolds(record, signer.publicKey))
    throw new ApprovalError(
      'payload_invalid',
      'The signature did not verify; nothing was written.',
    );
  writeApprovals(flow.file, upsertRecord(existing, record));
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
    pruned: file.records.length - existing.length,
    floorCommand: `flowctl trust add floor ${flow.name} ${revision}`,
  };
}
