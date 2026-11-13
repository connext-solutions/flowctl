import { createDecipheriv } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { TrustError } from './errors.js';
import { decodeB64, KeyFileSchema } from './key-file.js';
import {
  deriveReviewerKey,
  errnoOf,
  REVIEWER_AAD,
  REVIEWER_N_MAX,
  REVIEWER_P_MAX,
  REVIEWER_SCRYPT,
  REVIEWER_TAG,
  type ReviewerSigner,
  unlockedSeed,
} from './keys-crypto.js';

/**
 * Unlocks a reviewer key file with `passphrase`.
 *
 * @remarks The file is opened `O_NOFOLLOW` and `fstat`ed: a single-link regular file owned by the current user and
 *   closed to group and other. scrypt parameters outside the owner-key floors and ceilings are refused before any
 *   derivation.
 * @throws {TrustError} `key_missing`; `trust_tampered` (detail `key_file`) for a symlink, a hard link, another owner
 *   or loose mode bits; `key_params_weak`; `key_params_unsupported`; `key_unlock_failed` for a wrong passphrase, a
 *   damaged file or a file that is not a reviewer key.
 */
export function loadReviewerKey(
  keyFile: string,
  passphrase: string,
): ReviewerSigner {
  const parsed = KeyFileSchema.safeParse(readFileChecked(keyFile));
  if (!parsed.success)
    throw new TrustError(
      'key_unlock_failed',
      `${keyFile} is not a flowctl reviewer key.`,
    );
  const k = parsed.data;
  if (
    k.N < REVIEWER_SCRYPT.N ||
    k.r < REVIEWER_SCRYPT.r ||
    k.p < REVIEWER_SCRYPT.p ||
    k.N > REVIEWER_N_MAX ||
    k.p > REVIEWER_P_MAX
  )
    throw new TrustError(
      'key_params_weak',
      `${keyFile} uses scrypt N=${k.N} r=${k.r} p=${k.p}; flowctl needs N between 131072 and 1048576, r >= 8 and p between 1 and ${REVIEWER_P_MAX}.`,
    );
  if (128 * k.r * (k.N + 2) + 128 * k.r * k.p > REVIEWER_SCRYPT.maxmem)
    throw new TrustError(
      'key_params_unsupported',
      `${keyFile} uses scrypt parameters that need more than the 256 MiB flowctl allows.`,
    );
  const salt = decodeB64(k.salt, 16);
  const nonce = decodeB64(k.nonce, 12);
  const ct = decodeB64(k.ct, 32 + REVIEWER_TAG);
  if (salt === undefined || nonce === undefined || ct === undefined)
    throw new TrustError(
      'key_unlock_failed',
      `${keyFile} is damaged: salt, nonce or ciphertext has the wrong length.`,
    );
  const aesKey = deriveReviewerKey(passphrase, salt, k);
  try {
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce, {
      authTagLength: REVIEWER_TAG,
    }).setAAD(REVIEWER_AAD);
    decipher.setAuthTag(ct.subarray(32));
    return unlockedSeed(
      Buffer.concat([decipher.update(ct.subarray(0, 32)), decipher.final()]),
    );
  } catch {
    throw new TrustError(
      'key_unlock_failed',
      `Could not unlock ${keyFile}: wrong passphrase or a damaged key file.`,
    );
  } finally {
    aesKey.fill(0);
  }
}

function readFileChecked(file: string): unknown {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (errnoOf(e) === 'ENOENT')
      throw new TrustError('key_missing', `No reviewer key at ${file}.`);
    if (errnoOf(e) === 'ELOOP')
      throw new TrustError(
        'trust_tampered',
        `${file} is a symlink.`,
        'key_file',
      );
    throw new TrustError(
      'key_unlock_failed',
      `Cannot open ${file}: ${errnoOf(e) ?? String(e)}`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== userInfo().uid ||
      (st.mode & 0o077) !== 0
    )
      throw new TrustError(
        'trust_tampered',
        `${file} must be a single-link regular file that you own and that group and other cannot access (created 0400).`,
        'key_file',
      );
    return JSON.parse(readFileSync(fd, 'utf8'));
  } catch (e) {
    if (e instanceof TrustError) throw e;
    throw new TrustError(
      'key_unlock_failed',
      `Cannot read ${file} as a reviewer key.`,
    );
  } finally {
    closeSync(fd);
  }
}
