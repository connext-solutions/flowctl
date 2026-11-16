import { createCipheriv, randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { TrustError } from './errors.js';
import type { KeyFileDoc } from './key-file.js';
import {
  assertReviewerPassphrase,
  deriveReviewerKey,
  errnoOf,
  REVIEWER_AAD,
  REVIEWER_SCRYPT,
  REVIEWER_TAG,
  unlockedSeed,
} from './keys-crypto.js';
import { publicKeyPem } from './keys-pub.js';

/** Where {@link createReviewerKeyFile} wrote a key. */
export interface ReviewerKeyFiles {
  publicKey: Buffer;
  keyFile: string;
  pubFile: string;
}

/** The `.pub` path that goes with a key file: `<name>.key` becomes `<name>.pub`, any other name gets `.pub` added. */
export const pubFileOf = (keyFile: string): string =>
  keyFile.endsWith('.key') ? `${keyFile.slice(0, -4)}.pub` : `${keyFile}.pub`;

function assertAbsent(file: string): void {
  try {
    lstatSync(file);
  } catch {
    return;
  }
  throw new TrustError(
    'key_exists',
    `${file} already exists; flowctl never overwrites a key.`,
  );
}

function writeNew(file: string, text: string, mode: number): void {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      mode,
    );
  } catch (e) {
    if (errnoOf(e) === 'EEXIST')
      throw new TrustError('key_exists', `${file} already exists.`);
    throw new TrustError(
      'key_write_failed',
      `Cannot create ${file}: ${errnoOf(e) ?? String(e)}`,
    );
  }
  let cause: string | undefined;
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } catch (e) {
    cause = errnoOf(e) ?? String(e);
  } finally {
    closeSync(fd);
  }
  if (cause !== undefined) {
    rmSync(file, { force: true });
    throw new TrustError(
      'key_write_failed',
      `Writing ${file} failed (${cause}); the partial file was removed.`,
    );
  }
}

/**
 * Generates a reviewer key and writes it: `keyFile` holds a random Ed25519 seed sealed with AES-256-GCM under a
 * scrypt key from `passphrase` (own AAD, so an owner key file never opens as a reviewer key or the reverse), mode
 * 0400, created `O_EXCL|O_NOFOLLOW`; the `.pub` next to it holds the public key as PEM, mode 0644. The parent
 * directory is created 0700 when missing. No unencrypted private key is ever written.
 *
 * @param where the key file path, or a function that names it from the new public key (the default file name is the
 *   key id, which exists only after the key was generated).
 * @param passphrase read by the caller from `/dev/tty` only.
 * @remarks Costs about a second and 128 MiB (scrypt N = 2^17), on purpose. Every refusal happens before the derivation.
 * @throws {TrustError} `passphrase_too_short`; `key_exists` when the key file or the `.pub` exists in any form;
 *   `key_write_failed` when a directory or file cannot be written (a partial key file is removed).
 */
export function createReviewerKeyFile(
  where: string | ((publicKey: Buffer) => string),
  passphrase: string,
): ReviewerKeyFiles {
  assertReviewerPassphrase(passphrase);
  const seed = randomBytes(32);
  const { publicKey } = unlockedSeed(Buffer.from(seed));
  const keyFile = typeof where === 'string' ? where : where(publicKey);
  const pubFile = pubFileOf(keyFile);
  assertAbsent(keyFile);
  assertAbsent(pubFile);
  const dir = dirname(keyFile);
  if (!existsSync(dir))
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch (e) {
      throw new TrustError(
        'key_write_failed',
        `Cannot create the directory ${dir}: ${errnoOf(e) ?? String(e)}`,
      );
    }
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const aesKey = deriveReviewerKey(passphrase, salt, REVIEWER_SCRYPT);
  const cipher = createCipheriv('aes-256-gcm', aesKey, nonce, {
    authTagLength: REVIEWER_TAG,
  }).setAAD(REVIEWER_AAD);
  const ct = Buffer.concat([
    cipher.update(seed),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  aesKey.fill(0);
  seed.fill(0);
  const doc: KeyFileDoc = {
    v: 1,
    kdf: 'scrypt',
    N: REVIEWER_SCRYPT.N,
    r: REVIEWER_SCRYPT.r,
    p: REVIEWER_SCRYPT.p,
    salt: salt.toString('base64'),
    nonce: nonce.toString('base64'),
    ct: ct.toString('base64'),
  };
  writeNew(keyFile, JSON.stringify(doc), 0o400);
  try {
    writeNew(pubFile, publicKeyPem(publicKey), 0o644);
  } catch (e) {
    rmSync(keyFile, { force: true });
    throw e;
  }
  return { publicKey, keyFile, pubFile };
}
