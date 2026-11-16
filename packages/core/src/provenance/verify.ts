import { createPublicKey, verify } from 'node:crypto';
import type { Flow } from '../flow/index.js';
import {
  canonicalJson,
  reviewerKeyStatus,
  type TrustStore,
} from '../trust/index.js';
import { assertionHash } from './flow-hash.js';
import { encodeApprovalPayload, payloadOf } from './payload.js';
import {
  CaseApprovalRecordSchema,
  MAX_SIGNATURE_CHARS,
  type CaseApprovalRecord,
} from './record.js';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_REVISION = Number.MAX_SAFE_INTEGER;

/** What a verification reads: the checkout's identity, the flow, and the store whose keys count. */
export interface VerifyContext {
  project: string;
  flow: Flow;
  flowHash: string;
  store: TrustStore;
  now: Date;
}

/** True when `signature` (base64) is the Ed25519 signature of the record's payload under `publicKey` (32 raw bytes). */
export function signatureHolds(
  record: CaseApprovalRecord,
  publicKey: Buffer,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, publicKey]),
      format: 'der',
      type: 'spki',
    });
    const signature = Buffer.from(record.signature, 'base64');
    return (
      signature.length === 64 &&
      verify(null, encodeApprovalPayload(payloadOf(record)), key, signature)
    );
  } catch {
    return false;
  }
}

/**
 * Every record whose signature verifies under a `flows`-scope key that is in the store, not expired and not revoked,
 * whose revision is in range and whose `project` and `flowName` are the current ones (Amendment 2026-11-02 section
 * j, rule 3). A record that fails any check is ignored: it can neither select nor block, and it cannot raise the next
 * revision. The content hash is not checked here (see {@link verifyApprovals}).
 *
 * @returns the records and the reason codes of the ignored ones, each at most once.
 * @throws {TrustError} `trust_tampered` when the store's `reviewerKeys` section fails its read.
 */
export function authenticRecords(
  ctx: VerifyContext,
  raw: readonly unknown[],
): { records: CaseApprovalRecord[]; notes: string[] } {
  const notes = new Set<string>();
  const records: CaseApprovalRecord[] = [];
  for (const element of raw) {
    const parsed = CaseApprovalRecordSchema.safeParse(element);
    if (!parsed.success) {
      notes.add(
        signatureTooLarge(element) ? 'signature_too_large' : 'record_malformed',
      );
      continue;
    }
    const r = parsed.data;
    if (
      !Number.isInteger(r.revision) ||
      r.revision < 1 ||
      r.revision > MAX_REVISION
    ) {
      notes.add('revision_out_of_range');
      continue;
    }
    const { status, key } = reviewerKeyStatus(
      ctx.store,
      r.keyId,
      'flows',
      ctx.now,
    );
    if (status !== 'valid' || key === undefined) {
      notes.add(`record_key_${status}`);
      continue;
    }
    if (!signatureHolds(r, key.publicKeyBytes)) {
      notes.add('signature_invalid');
      continue;
    }
    if (r.project !== ctx.project) notes.add('record_project_mismatch');
    else if (r.flowName !== ctx.flow.name) notes.add('record_flow_mismatch');
    else records.push(r);
  }
  return { records, notes: [...notes] };
}

function signatureTooLarge(element: unknown): boolean {
  const sig =
    typeof element === 'object' && element !== null
      ? Reflect.get(element, 'signature')
      : undefined;
  return typeof sig === 'string' && sig.length > MAX_SIGNATURE_CHARS;
}

/** The highest revision among the authentic records of the current (project, flow name): the `H` of rule 3. */
export const highestRevision = (
  records: readonly CaseApprovalRecord[],
): number => records.reduce((h, r) => Math.max(h, r.revision), 0);

const sameAssertionHashes = (r: CaseApprovalRecord, flow: Flow): boolean =>
  r.assertions.length === flow.assertions.length &&
  r.assertions.every((a, i) => {
    const mine = flow.assertions[i];
    return mine !== undefined && a.hash === assertionHash(mine);
  });

const agreement = (r: CaseApprovalRecord): string =>
  canonicalJson([
    r.assertions.map((a) => [a.polarity, a.number ?? null]),
    r.baseline?.value ?? null,
  ]);

/** The outcome of checking a flow's approval records. */
export interface ApprovalVerdict {
  /** True when a record at the highest revision verifies and that revision meets `required`. */
  verified: boolean;
  /** The revision of the selected records, when there are some. */
  revision?: number;
  /** The records that selected the verdict (several at a tie). */
  selected: CaseApprovalRecord[];
  notes: string[];
}

/**
 * The state of a flow's records (Amendment 2026-11-02 section j rule 5 and section l): authentic records of the
 * current content hash and assertion hashes, the highest revision `h`, and a tie that must agree on the polarity of
 * every item and the baseline value (`record_tie_conflict`); `h` below `required` is `revision_below_floor`.
 *
 * @param required the required revision of {@link requiredRevision}, absent when no source has one.
 */
export function verifyApprovals(
  ctx: VerifyContext,
  raw: readonly unknown[],
  required: number | undefined,
): ApprovalVerdict {
  const { records, notes } = authenticRecords(ctx, raw);
  const current = records.filter((r) => {
    if (r.flowHash !== ctx.flowHash) {
      notes.push('record_hash_mismatch');
      return false;
    }
    if (!sameAssertionHashes(r, ctx.flow)) {
      notes.push('record_assertions_mismatch');
      return false;
    }
    return true;
  });
  const h = highestRevision(current);
  const selected = current.filter((r) => r.revision === h);
  const reasons = new Set(notes);
  const fail = (...more: string[]): ApprovalVerdict => {
    more.forEach((m) => reasons.add(m));
    return { verified: false, selected, notes: [...reasons] };
  };
  if (selected.length === 0) return fail();
  const first = selected[0];
  if (first === undefined) return fail();
  if (selected.some((r) => agreement(r) !== agreement(first)))
    return fail('record_tie_conflict');
  if (required !== undefined && h < required)
    return fail('revision_below_floor');
  return { verified: true, revision: h, selected, notes: [...reasons] };
}
