import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AnchorLocationSchema, type AnchorLocation } from './anchor-io.js';
import { canonicalJson } from './canonical.js';
import type { OwnerKey } from './owner-key.js';
import type { TrustStoreDoc } from './schema.js';

/**
 * The hash-chained change log next to `trust.json` (ADR 0025 section 3 "Integrity", Amendment 2026-11-02 s.5). This
 * module holds its shape and builders; parsing and verification are in `log-read.ts`.
 */
export const LOG_FILE = 'trust.log';

/** `prev` of the first line. */
export const ZERO = '0'.repeat(64);

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);
const Sig = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
/** A raw 32-byte Ed25519 public key in standard base64. */
const Key32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/);

/** The shape of one `trust.log` line; `log-read.ts` parses with it. */
export const LineSchema = z.discriminatedUnion('kind', [
  z
    .object({
      seq: z.number().int().min(0),
      prev: Hex64,
      kind: z.literal('genesis'),
      body: z
        .object({
          storeId: z.string().uuid(),
          ownerFingerprint: Hex64,
          anchor: AnchorLocationSchema,
          replaces: z
            .object({ fingerprint: Hex64, head: Hex64 })
            .strict()
            .optional(),
        })
        .strict(),
      sig: Sig,
    })
    .strict(),
  z
    .object({
      seq: z.number().int().min(0),
      prev: Hex64,
      kind: z.literal('replaced'),
      body: z
        .object({ newFingerprint: Hex64, newStoreId: z.string().uuid() })
        .strict(),
      sig: Sig,
    })
    .strict(),
  z
    .object({
      seq: z.number().int().min(0),
      prev: Hex64,
      kind: z.literal('write'),
      body: z.object({ docSha256: Hex64 }).strict(),
    })
    .strict(),
  z
    .object({
      seq: z.number().int().min(0),
      prev: Hex64,
      kind: z.literal('rotate'),
      body: z
        .object({
          from: Hex64,
          to: Hex64,
          oldPublicKey: Key32,
          newPublicKey: Key32,
        })
        .strict(),
      sigOld: Sig,
      sigNew: Sig,
    })
    .strict(),
]);

/**
 * One `trust.log` line. `genesis`, `rotate` and `replaced` are owner-signed; `write` records the digest of the document
 * it committed. A `genesis` of a store made by `trust init --replace` names the old fingerprint and head (`replaces`);
 * `replaced` ends the old store's log (Amendment 2026-11-02 section 6).
 */
export type LogLine = z.infer<typeof LineSchema>;

const sha256 = (s: string): string =>
  createHash('sha256').update(s).digest('hex');

/** The text of a line: canonical JSON, the bytes its hash covers (without the newline). */
export const lineText = (line: LogLine): string => canonicalJson(line);

/** The hash of a line, which the next line's `prev` and `trust.json`'s `head` carry. */
export const lineHash = (line: LogLine): string => sha256(lineText(line));

/** The digest of a store document a `write` line commits: canonical JSON of the document without `head`. */
export function docDigest(doc: TrustStoreDoc): string {
  const { head: _head, ...rest } = doc;
  return sha256(canonicalJson(rest));
}

/** A new store id, the key of its anchor record. */
export const newStoreId = (): string => randomUUID();

/**
 * The first line of a new log, signed with the owner key; `replaces` names the store a `trust init --replace` replaced.
 * It names the store's anchor, so removing the anchor entry
 * from `trust.json` is detected even when the rest of the log is rewritten (no downgrade, Amendment 2026-11-02 s.7).
 */
export function genesisLine(
  key: OwnerKey,
  storeId: string,
  anchor: AnchorLocation,
  replaces?: { fingerprint: string; head: string },
): Extract<LogLine, { kind: 'genesis' }> {
  const unsigned = {
    seq: 0,
    prev: ZERO,
    kind: 'genesis' as const,
    body: {
      storeId,
      ownerFingerprint: key.fingerprint,
      anchor,
      ...(replaces === undefined ? {} : { replaces }),
    },
  };
  return { ...unsigned, sig: key.signLine('genesis', unsigned) };
}

/** The `write` line that commits `doc` after `last`. */
export const writeLine = (last: LogLine, doc: TrustStoreDoc): LogLine => ({
  seq: last.seq + 1,
  prev: lineHash(last),
  kind: 'write',
  body: { docSha256: docDigest(doc) },
});
