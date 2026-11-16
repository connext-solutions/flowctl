import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  scryptSync,
  sign,
} from 'node:crypto';
import { TrustError } from './errors.js';
import { reviewerKeyId } from './keys-schema.js';

/** The AAD of a reviewer key file: it keeps a reviewer key and an owner key from opening as each other. */
export const REVIEWER_AAD = Buffer.from('flowctl-reviewer-key-v1');
/** The scrypt cost of a new reviewer key (N = 2^17, about a second and 128 MiB), and the memory ceiling. */
export const REVIEWER_SCRYPT = {
  N: 131_072,
  r: 8,
  p: 1,
  maxmem: 268_435_456,
} as const;
/** The ceilings a loaded file's scrypt parameters may not pass. */
export const REVIEWER_N_MAX = 1_048_576;
export const REVIEWER_P_MAX = 16;
/** The AES-GCM tag length of a reviewer key file. */
export const REVIEWER_TAG = 16;
const MIN_CODE_POINTS = 16;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** An unlocked reviewer key. It exists only in this process; only the encrypted file is ever written. */
export interface ReviewerSigner {
  publicKey: Buffer;
  keyId: string;
  /** Ed25519 signature (base64) of `message`; the caller frames the message (ADR 0020). */
  sign(message: Buffer): string;
}

/**
 * Refuses a reviewer-key passphrase under 16 code points after NFKC. The caller reads it from `/dev/tty` only.
 *
 * @throws {TrustError} `passphrase_too_short`.
 */
export function assertReviewerPassphrase(passphrase: string): void {
  if ([...passphrase.normalize('NFKC')].length < MIN_CODE_POINTS)
    throw new TrustError(
      'passphrase_too_short',
      `The reviewer-key passphrase needs at least ${MIN_CODE_POINTS} characters (after NFKC).`,
    );
}

/** The AES key scrypt derives from the NFKC form of `pass`. */
export const deriveReviewerKey = (
  pass: string,
  salt: Buffer,
  o: { N: number; r: number; p: number },
): Buffer =>
  scryptSync(pass.normalize('NFKC'), salt, 32, {
    ...o,
    maxmem: REVIEWER_SCRYPT.maxmem,
  });

/** The `code` of a Node system error, if it has one. */
export const errnoOf = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

/** Builds the signer of a 32-byte Ed25519 seed and zeroes the seed. */
export function unlockedSeed(seed: Buffer): ReviewerSigner {
  const privateKey: KeyObject = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  seed.fill(0);
  const spki = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  const publicKey = Buffer.from(spki.subarray(spki.length - 32));
  return {
    publicKey,
    keyId: reviewerKeyId(publicKey),
    sign: (message) => sign(null, message, privateKey).toString('base64'),
  };
}
