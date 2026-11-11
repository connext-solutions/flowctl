import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalJson } from './canonical.js';
import { TrustError } from './errors.js';
import {
  LOG_FILE,
  LineSchema,
  ZERO,
  docDigest,
  lineHash,
  type LogLine,
} from './log.js';
import type { TrustStoreDoc } from './schema.js';
import { fingerprintOf, lineMessage, verifyMessage } from './signing.js';

/**
 * How the owner finishes an interrupted swap of `storeDir` (Amendment 2026-11-02 section 6, step 4).
 *
 * @example finishByHand('/home/a/.config/flowctl')
 */
export const finishByHand = (storeDir: string): string =>
  `If ${storeDir}.new exists, the replacement did not finish moving into place; finish it by hand: if owner.key.new is in the owner-key directory, rename owner.key to owner.key.retired-<UTC date>.<n> and owner.key.new to owner.key, then rename ${storeDir} to ${storeDir}.replaced-<UTC date>.<n> and ${storeDir}.new to ${storeDir}.`;

const tampered = (detail: string, message: string): TrustError =>
  new TrustError('trust_tampered', message, detail);

function parseLine(text: string, n: number): LogLine {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw tampered('log_chain', `trust.log line ${n} is not JSON.`);
  }
  const parsed = LineSchema.safeParse(v);
  if (!parsed.success || canonicalJson(parsed.data) !== text)
    throw tampered(
      'log_chain',
      `trust.log line ${n} is not a valid line in canonical form.`,
    );
  return parsed.data;
}

/**
 * Parses and verifies `trust.log`: canonical lines, `seq` from 0, each `prev` the hash of the line before, a first
 * line of kind `genesis` signed by the owner key it names, then `write` and `rotate` lines (each rotation verified with
 * the key current before it) and at most one `replaced` line, last; the key current at the end must be the pinned one.
 *
 * @returns the lines, in order.
 * @throws {TrustError} `trust_tampered` with detail `log_chain` for any break, or `log_genesis` for a first line
 *   that is not a valid owner-signed genesis.
 */
export function verifyLog(
  text: string,
  owner: { publicKey: Buffer; fingerprint: string },
): LogLine[] {
  const rows = text.split('\n');
  if (rows.at(-1) !== '')
    throw tampered('log_chain', 'trust.log does not end with a newline.');
  const lines = rows.slice(0, -1).map(parseLine);
  const first = lines[0];
  if (first?.kind !== 'genesis' || first.seq !== 0 || first.prev !== ZERO)
    throw tampered(
      'log_genesis',
      'trust.log does not start with a genesis line.',
    );
  const firstRotate = lines.find((l) => l.kind === 'rotate');
  let current =
    firstRotate?.kind === 'rotate'
      ? Buffer.from(firstRotate.body.oldPublicKey, 'base64')
      : owner.publicKey;
  const { sig, ...unsigned } = first;
  if (
    first.body.ownerFingerprint !== fingerprintOf(current) ||
    !verifyMessage(current, lineMessage('genesis', unsigned), sig)
  )
    throw tampered(
      'log_genesis',
      'The genesis line of trust.log is not signed by the owner key it names.',
    );
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const prev = lines[i - 1];
    if (
      line === undefined ||
      prev === undefined ||
      line.kind === 'genesis' ||
      line.seq !== i ||
      line.prev !== lineHash(prev)
    )
      throw tampered(
        'log_chain',
        `trust.log breaks its hash chain at line ${i}.`,
      );
    if (line.kind === 'rotate') current = verifyRotate(line, current, i);
    if (line.kind === 'replaced') verifyReplaced(line, current, i, lines);
  }
  if (fingerprintOf(current) !== owner.fingerprint)
    throw tampered(
      'log_chain',
      'The owner key at the end of trust.log is not the key trust.json pins; the store was changed outside flowctl.',
    );
  return lines;
}

/**
 * Checks a `replaced` line: signed by the key current before it, and the last line of the log.
 *
 * @throws {TrustError} `trust_tampered` with detail `log_chain`.
 */
function verifyReplaced(
  line: Extract<LogLine, { kind: 'replaced' }>,
  current: Buffer,
  i: number,
  lines: LogLine[],
): void {
  const { sig, ...unsigned } = line;
  if (
    i !== lines.length - 1 ||
    !verifyMessage(current, lineMessage('replaced', unsigned), sig)
  )
    throw tampered(
      'log_chain',
      `The replacement record at line ${i} of trust.log is not the owner-signed last line.`,
    );
}

/**
 * Checks one `rotate` line against the key current before it: it names that key, is signed by it (`sigOld`), and is
 * signed by the new key it names (`sigNew`). Lines before a rotation therefore still verify after it.
 *
 * @returns the new current key.
 * @throws {TrustError} `trust_tampered` with detail `log_chain`.
 */
function verifyRotate(
  line: Extract<LogLine, { kind: 'rotate' }>,
  current: Buffer,
  i: number,
): Buffer {
  const { sigOld, sigNew, ...unsigned } = line;
  const oldKey = Buffer.from(line.body.oldPublicKey, 'base64');
  const newKey = Buffer.from(line.body.newPublicKey, 'base64');
  const message = lineMessage('rotate', unsigned);
  if (
    !oldKey.equals(current) ||
    line.body.from !== fingerprintOf(oldKey) ||
    line.body.to !== fingerprintOf(newKey) ||
    !verifyMessage(oldKey, message, sigOld) ||
    !verifyMessage(newKey, message, sigNew)
  )
    throw tampered(
      'log_chain',
      `The key rotation at line ${i} of trust.log is not signed by both owner keys.`,
    );
  return newKey;
}

/**
 * Checks that `doc` is what the log committed: its `head` is the hash of the last `write` line, or of the one before
 * it when the last line is a write that never reached `trust.json` (a crash between the log append and the rename).
 *
 * @remarks The one-line tolerance means a `trust.json` put back to the previous version is accepted until the anchor
 *   of Amendment 2026-11-02 section 7 holds a second head; the next write keeps the rolled-back line in the log.
 * @returns how many trailing lines are uncommitted (0 or 1); the next write keeps them and appends after them.
 * @throws {TrustError} `trust_tampered` with detail `log_head_mismatch` when the head names no such line, or
 *   `log_doc_mismatch` when the document differs from the digest its line committed (an edit outside flowctl).
 */
export function checkHead(lines: LogLine[], doc: TrustStoreDoc): 0 | 1 {
  const digest = docDigest(doc);
  for (const pending of [0, 1] as const) {
    const at = lines[lines.length - 1 - pending];
    if (at?.kind !== 'write' || lineHash(at) !== doc.head) continue;
    if (at.body.docSha256 !== digest)
      throw tampered(
        'log_doc_mismatch',
        'trust.json differs from the version trust.log committed; the store was changed outside flowctl.',
      );
    return pending;
  }
  throw tampered(
    'log_head_mismatch',
    'The head recorded in trust.json is not the end of trust.log; the store or its log was changed outside flowctl.',
  );
}

/**
 * Reads and verifies `trust.log` against the document (ADR 0025 section 3, "Integrity"): the chain, the owner-signed
 * genesis and the committed line must match it.
 *
 * @param read reads a file with the store's checks (no symlink, one link, owner-only writable).
 * @remarks A store without a log is refused. Stores made before the log existed are not migrated: accepting a store
 *   with no log would let anyone who can write the store directory turn any store into that form (owner decision
 *   2026-11-07, internal use; such a store is made again with `trust init`).
 * @throws {TrustError} `trust_tampered` with detail `log_missing` (no log, or no head), `no_owner_key`, or a detail
 *   of {@link verifyLog} or {@link checkHead}; `store_replaced` when the log ends with a `replaced` line;
 *   `store_unreadable` when the log cannot be read.
 */
export function readLog(
  dir: string,
  doc: TrustStoreDoc,
  key: Buffer | undefined,
  read: (file: string) => string,
): { log: LogLine[]; pending: 0 | 1 } {
  const file = join(dir, LOG_FILE);
  if (!existsSync(file) || doc.head === undefined)
    throw tampered(
      'log_missing',
      `The trust store in ${dir} has no ${doc.head === undefined ? 'head' : LOG_FILE}. A store made before flowctl kept a log cannot be trusted, and neither can one whose log was removed: move ${dir} away and run flowctl trust init.`,
    );
  if (key === undefined || doc.ownerFingerprint === undefined)
    throw tampered(
      'no_owner_key',
      `The trust store in ${dir} has a log but pins no owner key.`,
    );
  const log = verifyLog(read(file), {
    publicKey: key,
    fingerprint: doc.ownerFingerprint,
  });
  const last = log.at(-1);
  if (last?.kind === 'replaced')
    throw new TrustError(
      'store_replaced',
      `The trust store in ${dir} was replaced by flowctl trust init --replace (new owner key ${last.body.newFingerprint}). ${finishByHand(dir)}`,
    );
  return { log, pending: checkHead(log, doc) };
}
