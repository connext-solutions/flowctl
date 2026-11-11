import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  scryptSync,
  sign,
} from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TrustError } from './errors.js';
import {
  assertKeyDir,
  assertNoKeyFile,
  decodeB64,
  type KeyFileDoc,
  KeyFileSchema,
  readKeyFile,
  writeKeyFile,
  type KeyFileName,
} from './key-file.js';
import { assertNotInRepository } from './location.js';
import {
  entryBytes,
  fingerprintOf,
  lineMessage,
  type SignedEntry,
} from './signing.js';

const AAD = Buffer.from('flowctl-owner-key-v1');
const SCRYPT = { N: 131_072, r: 8, p: 1, maxmem: 268_435_456 } as const;
const N_MAX = 1_048_576;
const P_MAX = 16;
const MIN_CODE_POINTS = 16;
const TAG = 16;
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The unlocked owner key. It exists only in this process; only the encrypted file is ever written. */
export interface OwnerKey {
  publicKey: Buffer;
  fingerprint: string;
  /** Ed25519 signature (base64) over `"flowctl-entry-v1\n"` + canonical `{id, kind, value}`. */
  signEntry(entry: SignedEntry): string;
  /** Ed25519 signature (base64) of a signed `trust.log` line of `kind`, over {@link lineMessage}. */
  signLine(kind: 'genesis' | 'rotate' | 'replaced', unsigned: unknown): string;
}

/**
 * Creates the owner key in `keyDir` as `owner.key`: a random 32-byte Ed25519 seed sealed with AES-256-GCM
 * under a scrypt key derived from `passphrase`. `keyDir` is created 0700 when missing; an existing one must
 * already be a 0700 directory the current user owns.
 *
 * @param passphrase read by the caller from `/dev/tty` only, never argv, environment or a file.
 * @remarks Costs about a second of CPU and 128 MiB for scrypt (N = 2^17), on purpose. Every refusal is
 *   decided before the derivation runs.
 * @throws {TrustError} `passphrase_too_short` under 16 code points after NFKC; `trust_tampered` when
 *   `keyDir` is inside a repository or is not a private directory; `key_exists` when `owner.key` exists;
 *   `key_write_failed` when the directory or the file cannot be written.
 * @see docs/adr/0025-trust-store.md (Amendment 2026-11-02, section 5)
 */
export function createOwnerKey(
  keyDir: string,
  passphrase: string,
  name: KeyFileName = 'owner.key',
): OwnerKey {
  assertPassphrase(passphrase);
  assertNotInRepository(keyDir);
  if (!existsSync(keyDir)) {
    try {
      mkdirSync(keyDir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new TrustError(
        'key_write_failed',
        `Cannot create the owner-key directory ${keyDir}: ${String(e)}`,
      );
    }
  }
  assertKeyDir(keyDir);
  assertNoKeyFile(keyDir, name);
  const seed = randomBytes(32);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const aesKey = derive(passphrase, salt, SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, {
    authTagLength: TAG,
  }).setAAD(AAD);
  const ct = Buffer.concat([
    cipher.update(seed),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  aesKey.fill(0);
  const key = unlocked(seed);
  writeKeyFile(
    keyDir,
    {
      v: 1,
      kdf: 'scrypt',
      N: SCRYPT.N,
      r: SCRYPT.r,
      p: SCRYPT.p,
      salt: salt.toString('base64'),
      nonce: nonce.toString('base64'),
      ct: ct.toString('base64'),
    },
    name,
  );
  return key;
}

/**
 * Unlocks `<keyDir>/owner.key` with `passphrase`.
 *
 * @throws {TrustError} `key_missing` when there is no key; `trust_tampered` (detail `key_dir` or
 *   `key_file`) for a directory or file that others can reach, a symlink or a hard link;
 *   `key_params_weak` for scrypt parameters outside the floors and ceilings;
 *   `key_params_unsupported` for parameters scrypt cannot run within `maxmem`; `key_unlock_failed` for a
 *   wrong passphrase or a damaged file; `rotate_incomplete` when `owner.key` is asked for while a rotation left
 *   `owner.key.new` (which of the two is the owner key then depends on the store). Every check except the
 *   passphrase runs before any derivation.
 */
export function loadOwnerKey(
  keyDir: string,
  passphrase: string,
  name: KeyFileName = 'owner.key',
): OwnerKey {
  if (name === 'owner.key' && existsSync(join(keyDir, 'owner.key.new')))
    throw new TrustError(
      'rotate_incomplete',
      `An owner-key rotation or store replacement did not finish (${join(keyDir, 'owner.key.new')} is still there). Run flowctl trust key rotate-owner, or flowctl trust init --replace if you were replacing the store.`,
    );
  const parsed = KeyFileSchema.safeParse(readKeyFile(keyDir, name));
  if (!parsed.success)
    throw new TrustError(
      'key_unlock_failed',
      `The owner key file in ${keyDir} is not a flowctl owner key.`,
    );
  const k = parsed.data;
  assertParams(keyDir, k);
  const salt = decodeB64(k.salt, 16);
  const nonce = decodeB64(k.nonce, 12);
  const ct = decodeB64(k.ct, 32 + TAG);
  if (salt === undefined || nonce === undefined || ct === undefined)
    throw new TrustError(
      'key_unlock_failed',
      `The owner key file in ${keyDir} is damaged: salt, nonce or ciphertext has the wrong length.`,
    );
  const aesKey = derive(passphrase, salt, { ...k, maxmem: SCRYPT.maxmem });
  let seed: Buffer;
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce, {
      authTagLength: TAG,
    }).setAAD(AAD);
    decipher.setAuthTag(ct.subarray(32));
    seed = Buffer.concat([
      decipher.update(ct.subarray(0, 32)),
      decipher.final(),
    ]);
  } catch {
    throw new TrustError(
      'key_unlock_failed',
      `Could not unlock the owner key in ${keyDir}: wrong passphrase or a damaged key file.`,
    );
  } finally {
    aesKey.fill(0);
  }
  return unlocked(seed);
}

/**
 * Refuses scrypt parameters outside the ADR floors (N >= 2^17, r >= 8, p >= 1) and ceilings (N <= 2^20,
 * p <= 16), then parameters whose memory need exceeds `maxmem`.
 *
 * @remarks OpenSSL needs `128·r·(N+2) + 128·r·p` bytes, so with r = 8 and `maxmem` 268435456 no N above
 *   2^17 can run: the ADR's N ceiling of 2^20 is reachable only with a larger `maxmem`. `p <= 16` is this
 *   implementation's cap on CPU work; the ADR sets none.
 */
function assertParams(keyDir: string, k: KeyFileDoc): void {
  if (
    k.N < SCRYPT.N ||
    k.r < SCRYPT.r ||
    k.p < SCRYPT.p ||
    k.N > N_MAX ||
    k.p > P_MAX
  )
    throw new TrustError(
      'key_params_weak',
      `The owner key in ${keyDir} uses scrypt N=${k.N} r=${k.r} p=${k.p}; flowctl needs N between 131072 and 1048576, r >= 8 and p between 1 and ${P_MAX}. Restore the key file from a backup.`,
    );
  if (128 * k.r * (k.N + 2) + 128 * k.r * k.p > SCRYPT.maxmem)
    throw new TrustError(
      'key_params_unsupported',
      `The owner key in ${keyDir} uses scrypt N=${k.N} r=${k.r} p=${k.p}, which needs more than the 256 MiB flowctl allows. Restore the key file from a backup.`,
    );
}

function unlocked(seed: Buffer): OwnerKey {
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
    fingerprint: fingerprintOf(publicKey),
    signEntry: (entry) =>
      sign(null, entryBytes(entry), privateKey).toString('base64'),
    signLine: (kind, unsigned) =>
      sign(null, lineMessage(kind, unsigned), privateKey).toString('base64'),
  };
}

const derive = (
  pass: string,
  salt: Buffer,
  o: { N: number; r: number; p: number; maxmem: number },
): Buffer =>
  scryptSync(pass.normalize('NFKC'), salt, 32, {
    N: o.N,
    r: o.r,
    p: o.p,
    maxmem: o.maxmem,
  });

function assertPassphrase(passphrase: string): void {
  if ([...passphrase.normalize('NFKC')].length < MIN_CODE_POINTS)
    throw new TrustError(
      'passphrase_too_short',
      `The owner-key passphrase needs at least ${MIN_CODE_POINTS} characters (after NFKC).`,
    );
}
