import dayjs from 'dayjs';
import { z } from 'zod';
import { TrustError } from './errors.js';
import { fingerprintOf, type SignedEntry } from './signing.js';
import type { TrustStore } from './store.js';

/** What a reviewer key may approve: flow changes or spec metadata (ADR 0025 section 2, `reviewerKeys`). */
export const REVIEWER_SCOPES = ['flows', 'spec'] as const;
export type ReviewerScope = (typeof REVIEWER_SCOPES)[number];

/**
 * Where the private half lives, as the owner declared it. `file` is a passphrase-encrypted key file; `hardware` is a
 * key that never leaves a device. flowctl cannot verify either claim and never accepts an unencrypted file key.
 */
export const REVIEWER_CUSTODY = ['file', 'hardware'] as const;
export type ReviewerCustody = (typeof REVIEWER_CUSTODY)[number];

/** The longest a reviewer key may live, in whole days. There is no default: the owner always names it. */
export const MAX_KEY_DAYS = 365;

const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u;
const MAX_PERSON = 128;
const MAX_REASON = 256;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX64 = /^[0-9a-f]{64}$/;

const isoInstant = (s: string): boolean =>
  ISO.test(s) && dayjs(s).toISOString() === s;

const visibleText = (s: string): boolean =>
  ![...s].some((c) => c !== ' ' && HIDDEN.test(c)) &&
  s === s.trim() &&
  s === s.normalize('NFC');

const Person = z
  .string()
  .min(1)
  .refine(
    (s) => [...s].length <= MAX_PERSON,
    `at most ${MAX_PERSON} characters`,
  )
  .refine(visibleText, 'NFC text without control or hidden characters');

const KeyEntry = z
  .object({
    kind: z.literal('key'),
    id: z.string().regex(HEX64),
    publicKey: z.string(),
    person: Person,
    scope: z.enum(REVIEWER_SCOPES),
    expiresAt: z.string().refine(isoInstant),
    custody: z.enum(REVIEWER_CUSTODY),
    addedAt: z.string().refine(isoInstant),
    sig: z.string().min(1),
  })
  .strict();

const RevokedEntry = z
  .object({
    kind: z.literal('revoked'),
    keyId: z.string().regex(HEX64),
    revokedAt: z.string().refine(isoInstant),
    reason: z
      .string()
      .refine((s) => [...s].length <= MAX_REASON && visibleText(s))
      .optional(),
    sig: z.string().min(1),
  })
  .strict();

const ReviewerEntry = z.discriminatedUnion('kind', [KeyEntry, RevokedEntry]);

/** One `reviewerKeys` element parsed strictly, or `undefined` when it is neither a key nor a revocation. */
export function parseReviewerElement(
  raw: unknown,
): z.infer<typeof ReviewerEntry> | undefined {
  const parsed = ReviewerEntry.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

/** A registered reviewer key as the store holds it, after its owner signature was verified. */
export type ReviewerKey = z.infer<typeof KeyEntry> & { publicKeyBytes: Buffer };

/** A signed revocation of one key. */
export type ReviewerRevocation = z.infer<typeof RevokedEntry>;

/** Every reviewer key and every revocation of a store, read strictly. */
export interface ReviewerKeys {
  keys: ReviewerKey[];
  revoked: ReviewerRevocation[];
}

const tampered = (what: string): TrustError =>
  new TrustError(
    'trust_tampered',
    `The reviewerKeys section of the trust store is damaged (${what}); the store was changed outside flowctl.`,
    'reviewer_keys',
  );

/** The id of a reviewer key: lowercase hex sha256 of its raw 32-byte public key. */
export const reviewerKeyId = (publicKey: Buffer): string =>
  fingerprintOf(publicKey);

/**
 * What the owner signature of a `reviewerKeys` element covers: the element without `sig`, under the key id (a key) or
 * `revoked:<keyId>` (a revocation), so a revocation can never stand in for a key or the reverse.
 */
export function reviewerSigned(
  entry:
    | Omit<z.infer<typeof KeyEntry>, 'sig'>
    | Omit<ReviewerRevocation, 'sig'>,
): SignedEntry {
  return {
    id: entry.kind === 'key' ? entry.id : `revoked:${entry.keyId}`,
    kind: 'reviewerKeys',
    value: entry,
  };
}

/** `person` as stored: NFC, 1 to 128 characters, no control, format or odd space characters, no edge spaces. */
export function validatePerson(person: string): string {
  const text = person.normalize('NFC');
  if (!Person.safeParse(text).success)
    throw new TrustError(
      'trust_entry_invalid',
      `--person must be 1 to ${MAX_PERSON} characters of plain text (no control, hidden or edge-space characters).`,
    );
  return text;
}

/** `scope` as one of {@link REVIEWER_SCOPES}. */
export function validateScope(scope: string): ReviewerScope {
  const found = REVIEWER_SCOPES.find((s) => s === scope);
  if (found === undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `--scope must be ${REVIEWER_SCOPES.join(' or ')}, not ${JSON.stringify(scope)}.`,
    );
  return found;
}

/** `custody` as one of {@link REVIEWER_CUSTODY}. */
export function validateCustody(custody: string): ReviewerCustody {
  const found = REVIEWER_CUSTODY.find((c) => c === custody);
  if (found === undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `--custody must be ${REVIEWER_CUSTODY.join(' or ')}, not ${JSON.stringify(custody)}.`,
    );
  return found;
}

/** `--expires` as whole days from 1 to {@link MAX_KEY_DAYS}. */
export function validateDays(text: string): number {
  const days = /^[1-9]\d{0,3}$/.test(text) ? Number(text) : 0;
  if (days < 1 || days > MAX_KEY_DAYS)
    throw new TrustError(
      'trust_entry_invalid',
      `--expires must be a whole number of days from 1 to ${MAX_KEY_DAYS}, not ${JSON.stringify(text)}.`,
    );
  return days;
}

/** The optional revocation reason as stored. */
export function validateReason(reason: string | undefined): string | undefined {
  if (reason === undefined) return undefined;
  if (!RevokedEntry.shape.reason.safeParse(reason).success || reason === '')
    throw new TrustError(
      'trust_entry_invalid',
      `--reason must be 1 to ${MAX_REASON} characters of plain text.`,
    );
  return reason.normalize('NFC');
}

/**
 * Every reviewer key and revocation of `store`, each parsed strictly and verified against the owner key on this read.
 *
 * @remarks Nothing is skipped: an element that does not parse, is not owner-signed, repeats a key id, revokes a key
 *   the store does not hold, or carries a key id that does not match its public key is tampering. A key counts as
 *   revoked from the next read after its revocation was written, with no cut-off date.
 * @throws {TrustError} `trust_tampered` as above.
 */
export function readReviewerKeys(store: TrustStore): ReviewerKeys {
  const keys: ReviewerKey[] = [];
  const revoked: ReviewerRevocation[] = [];
  for (const raw of store.data.reviewerKeys) {
    const parsed = ReviewerEntry.safeParse(raw);
    if (!parsed.success)
      throw tampered('an element is not a key or a revocation');
    const entry = parsed.data;
    const { sig, ...value } = entry;
    store.assertSigned(reviewerSigned(value), sig);
    if (entry.kind === 'revoked') {
      if (revoked.some((r) => r.keyId === entry.keyId))
        throw tampered('a key is revoked twice');
      revoked.push(entry);
      continue;
    }
    const publicKeyBytes = Buffer.from(entry.publicKey, 'base64');
    if (
      publicKeyBytes.length !== 32 ||
      publicKeyBytes.toString('base64') !== entry.publicKey ||
      reviewerKeyId(publicKeyBytes) !== entry.id
    )
      throw tampered('a key id does not match its public key');
    if (keys.some((k) => k.id === entry.id))
      throw tampered('a key id appears twice');
    keys.push({ ...entry, publicKeyBytes });
  }
  if (revoked.some((r) => !keys.some((k) => k.id === r.keyId)))
    throw tampered('a revocation names no key');
  return { keys, revoked };
}
