import { rmSync } from 'node:fs';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { assertCanWrite } from './admin.js';
import { TrustError } from './errors.js';
import { entryCommitted } from './keys-commit.js';
import { assertReviewerKeyPath, defaultReviewerKeyDir } from './keys-path.js';
import {
  type DeclaredCustody,
  type ReviewerCustody,
  type ReviewerKey,
  type ReviewerRevocation,
  type ReviewerScope,
  readReviewerKeys,
  reviewerKeyId,
  reviewerSigned,
  validateDays,
  validatePerson,
  validateReason,
  validateScope,
} from './keys-schema.js';
import { createReviewerKeyFile, type ReviewerKeyFiles } from './keys-seal.js';
import type { OwnerKey } from './owner-key.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

/** What the owner states about a reviewer key: whose it is, what it may approve and for how many days. */
export interface ReviewerKeyRequest {
  person: string;
  scope: ReviewerScope;
  days: number;
}

/**
 * The options of `trust key new|add` as typed, checked before any prompt.
 *
 * @throws {TrustError} `trust_entry_invalid` for a person, scope or expiry the rules refuse.
 */
export function validateKeyRequest(raw: {
  person: string;
  scope: string;
  expires: string;
}): ReviewerKeyRequest {
  return {
    person: validatePerson(raw.person),
    scope: validateScope(raw.scope),
    days: validateDays(raw.expires),
  };
}

const iso = (d: Date): string => dayjs(d).toISOString();

const expiryOf = (now: Date, days: number): string =>
  iso(dayjs(now).add(days, 'day').toDate());

function register(
  store: TrustStore,
  owner: OwnerKey,
  entry: Omit<ReviewerKey, 'sig' | 'publicKeyBytes'>,
): ReviewerKey {
  const sig = owner.signEntry(reviewerSigned(entry));
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, owner);
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      reviewerKeys: [...fresh.data.reviewerKeys, { ...entry, sig }],
    },
    owner,
  );
  return {
    ...entry,
    sig,
    publicKeyBytes: Buffer.from(entry.publicKey, 'base64'),
  };
}

function keyEntry(
  publicKey: Buffer,
  req: ReviewerKeyRequest,
  custody: ReviewerCustody,
  now: Date,
): Omit<ReviewerKey, 'sig' | 'publicKeyBytes'> {
  return {
    kind: 'key',
    id: reviewerKeyId(publicKey),
    publicKey: publicKey.toString('base64'),
    person: req.person,
    scope: req.scope,
    expiresAt: expiryOf(now, req.days),
    custody,
    addedAt: iso(now),
  };
}

function assertWritable(store: TrustStore, owner: OwnerKey): TrustStore {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, owner);
  readReviewerKeys(fresh);
  return fresh;
}

/**
 * Registers an existing public key (`flowctl trust key add`): an owner-signed `key` entry in `reviewerKeys`.
 * The owner declares where the private half lives (`declared-file` or `declared-hardware`); flowctl never sees it
 * and cannot check the claim, so the store records a declaration, not a fact. No unencrypted file key is accepted.
 *
 * @remarks Several active keys per person and scope are allowed (rotation needs an overlap). The store is read
 *   again after the owner answered, so a change written meanwhile is kept.
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store or a key id already registered (revoked or not);
 *   `trust_tampered` when the key is not the pinned owner key or `reviewerKeys` fails its strict read;
 *   `store_busy`.
 */
export function addReviewerKey(
  store: TrustStore,
  owner: OwnerKey,
  publicKey: Buffer,
  req: ReviewerKeyRequest,
  custody: DeclaredCustody,
  now: Date = new Date(),
): ReviewerKey {
  const fresh = assertWritable(store, owner);
  const id = reviewerKeyId(publicKey);
  if (readReviewerKeys(fresh).keys.some((k) => k.id === id))
    throw new TrustError(
      'trust_entry_invalid',
      `Key ${id} is already registered; nothing was changed.`,
    );
  return register(store, owner, keyEntry(publicKey, req, custody, now));
}

/** Where `trust key new` puts a key, and what it must stay out of. */
export interface NewKeyTarget {
  /** `--out`; the default is `<dir>/<keyId>.key`. */
  out?: string;
  /** The directory of the default file name; {@link defaultReviewerKeyDir} when left out (a seam for tests). */
  dir?: string;
  /** Directories the key may not be written in or under: the owner-key directory (the store is added here). */
  excluded: readonly string[];
}

/**
 * The directories and file `trust key new` would use, refused before any prompt.
 *
 * @returns the real path of `--out`, or of the default key directory.
 * @throws {TrustError} as {@link assertReviewerKeyPath}.
 */
export function planNewKey(store: TrustStore, target: NewKeyTarget): string {
  return assertReviewerKeyPath(
    target.out ?? target.dir ?? defaultReviewerKeyDir(),
    [...target.excluded, store.dir],
  );
}

/**
 * Generates a reviewer key and registers it in one step on the owner machine (`flowctl trust key new`): the sealed
 * key file and its `.pub` are written first, then the owner-signed entry; a registration that failed before the entry was committed removes both files; one that failed after the commit keeps them.
 *
 * @param passphrase the new key's passphrase, read from `/dev/tty` only.
 * @returns the entry and where the key files are.
 * @throws {TrustError} {@link planNewKey}'s refusals; `passphrase_too_short`, `key_exists`, `key_write_failed`; and
 *   {@link addReviewerKey}'s for the registration.
 */
export function createReviewerKey(
  store: TrustStore,
  owner: OwnerKey,
  req: ReviewerKeyRequest,
  target: NewKeyTarget,
  passphrase: string,
  now: Date = new Date(),
): { key: ReviewerKey; files: ReviewerKeyFiles } {
  assertWritable(store, owner);
  const place = planNewKey(store, target);
  const files = createReviewerKeyFile(
    target.out === undefined
      ? (publicKey) => join(place, `${reviewerKeyId(publicKey)}.key`)
      : place,
    passphrase,
  );
  try {
    return {
      key: register(store, owner, keyEntry(files.publicKey, req, 'file', now)),
      files,
    };
  } catch (e) {
    if (!entryCommitted(store, files.publicKey)) {
      rmSync(files.keyFile, { force: true });
      rmSync(files.pubFile, { force: true });
    }
    throw e;
  }
}

/**
 * The key `keyId` that `trust key revoke` would revoke, for the confirmation screen.
 *
 * @throws {TrustError} `trust_entry_invalid` when the store holds no such key or it is revoked already;
 *   `trust_tampered` as {@link readReviewerKeys}.
 */
export function planRevokeKey(store: TrustStore, keyId: string): ReviewerKey {
  const { keys, revoked } = readReviewerKeys(store);
  const key = keys.find((k) => k.id === keyId);
  if (key === undefined)
    throw new TrustError(
      'trust_entry_invalid',
      'The trust store holds no reviewer key with that id; nothing was changed.',
    );
  if (revoked.some((r) => r.keyId === keyId))
    throw new TrustError(
      'trust_entry_invalid',
      'That reviewer key is revoked already; nothing was changed.',
    );
  return key;
}

/**
 * Appends an owner-signed revocation of `keyId` (`flowctl trust key revoke`). The key entry stays, and so does every
 * earlier revocation: the list is append-only, and a key counts as revoked from the next store read, with no
 * cut-off date (`revokedAt` is for display).
 *
 * @remarks An editor of the same user can still cut a revocation out of `trust.json`; the hash-chained `trust.log`
 *   and the anchor show that (ADR 0025 section 6), the owner signature alone does not.
 * @throws {TrustError} {@link planRevokeKey}'s refusals, a `ci` store, `trust_tampered` for another owner key,
 *   `store_busy`.
 */
export function revokeReviewerKey(
  store: TrustStore,
  owner: OwnerKey,
  keyId: string,
  reason?: string,
  now: Date = new Date(),
): ReviewerRevocation {
  const fresh = assertWritable(store, owner);
  planRevokeKey(fresh, keyId);
  const text = validateReason(reason);
  const entry = {
    kind: 'revoked' as const,
    keyId,
    revokedAt: iso(now),
    ...(text === undefined ? {} : { reason: text }),
  };
  const sig = owner.signEntry(reviewerSigned(entry));
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      reviewerKeys: [...fresh.data.reviewerKeys, { ...entry, sig }],
    },
    owner,
  );
  return { ...entry, sig };
}

/** Why a reviewer key does or does not count for an approval. */
export type ReviewerKeyStatus =
  | 'valid'
  | 'revoked'
  | 'expired'
  | 'wrong_scope'
  | 'unknown';

/**
 * Whether key `keyId` may approve in `scope` at `now`, read from the signed store (ADR 0020, ADR 0025 section 2):
 * `revoked` wins over everything, then a scope mismatch (a `spec` key never signs flow approvals, nor the reverse),
 * then expiry.
 *
 * @returns the status and, unless `unknown`, the key (its `publicKeyBytes` verify the approval).
 * @throws {TrustError} `trust_tampered` as {@link readReviewerKeys}: every call re-verifies the whole section.
 */
export function reviewerKeyStatus(
  store: TrustStore,
  keyId: string,
  scope: ReviewerScope,
  now: Date = new Date(),
): { status: ReviewerKeyStatus; key?: ReviewerKey } {
  const { keys, revoked } = readReviewerKeys(store);
  const key = keys.find((k) => k.id === keyId);
  if (key === undefined) return { status: 'unknown' };
  if (revoked.some((r) => r.keyId === keyId)) return { status: 'revoked', key };
  if (key.scope !== scope) return { status: 'wrong_scope', key };
  if (!dayjs(now).isBefore(dayjs(key.expiresAt)))
    return { status: 'expired', key };
  return { status: 'valid', key };
}
