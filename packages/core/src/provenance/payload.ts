import { INVISIBLE_CLASS } from '../foundation/index.js';
import { canonicalJson } from '../trust/index.js';
import { ApprovalError } from './errors.js';
import type { CaseApprovalRecord } from './record.js';

/** The domain tag that starts every signed payload, so a signature made here is valid for nothing else. */
export const APPROVAL_DOMAIN = 'flowctl-case-approval/1';
const VERSION = 1;
const HIDDEN = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');

/** What a case-approval signature covers: every field of the record except the signature itself. */
export type ApprovalPayload = Omit<CaseApprovalRecord, 'signature' | 'v'>;

function text(s: string): Buffer {
  if (s !== s.normalize('NFC') || HIDDEN.test(s))
    throw new ApprovalError(
      'payload_invalid',
      'A signed field holds text that is not NFC or holds invisible or control characters.',
    );
  return Buffer.from(s, 'utf8');
}

function u32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
}

const field = (b: Buffer): Buffer => Buffer.concat([u32(b.length), b]);
const str = (s: string): Buffer => field(text(s));
const opt = (value: Buffer | undefined): Buffer =>
  value === undefined
    ? Buffer.from([0])
    : Buffer.concat([Buffer.from([1]), field(value)]);
const list = (items: Buffer[]): Buffer =>
  Buffer.concat([u32(items.length), ...items]);

/**
 * The bytes a reviewer key signs (ADR 0020 section f, ADR 0042): the domain tag, a version byte, then each field as
 * a 4-byte big-endian length and its bytes, in a fixed order; a list is its count then its items; an optional field
 * is a presence byte then the field. Text must be NFC and free of invisible code points; a nested object (a
 * `sourceRef`, a `number`) is canonical JSON. Two payloads that differ in any field, or only in where one field ends
 * and the next begins, give different bytes.
 *
 * @throws {ApprovalError} `payload_invalid` for text that is not NFC or holds an invisible code point, and for a
 *   value with no canonical JSON form.
 */
export function encodeApprovalPayload(p: ApprovalPayload): Buffer {
  const json = (v: unknown): Buffer => text(canonicalJson(v));
  try {
    return Buffer.concat([
      str(APPROVAL_DOMAIN),
      Buffer.from([VERSION]),
      str(p.project),
      str(p.flowName),
      str(p.flowHash),
      str(String(p.revision)),
      str(p.keyId),
      str(p.approvedAt),
      list(
        p.assertions.map((a) =>
          Buffer.concat([
            str(a.hash),
            opt(a.sourceRef === undefined ? undefined : json(a.sourceRef)),
            str(a.polarity),
            opt(a.number === undefined ? undefined : json(a.number)),
          ]),
        ),
      ),
      list(p.replayHashes.map(str)),
      str(p.evidenceHash),
      opt(
        p.baseline === undefined
          ? undefined
          : Buffer.concat([str(p.baseline.value), str(p.baseline.evidence)]),
      ),
    ]);
  } catch (e) {
    if (e instanceof ApprovalError) throw e;
    throw new ApprovalError(
      'payload_invalid',
      'A signed field has no canonical form.',
    );
  }
}

/** The payload of a record (the record without `v` and `signature`). */
export function payloadOf(record: CaseApprovalRecord): ApprovalPayload {
  const { v: _v, signature: _s, ...payload } = record;
  return payload;
}
