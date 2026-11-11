import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { TrustError } from './errors.js';

const KEY_FILE = 'owner.key';

/** The names an owner-key file may have: the key, and the staged new key of a rotation (Amendment 2026-11-02 s.5). */
export type KeyFileName = 'owner.key' | 'owner.key.new';
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** The JSON of `owner.key` (ADR 0025 Amendment 2026-11-02 section 5); unknown keys are refused. */
export const KeyFileSchema = z
  .object({
    v: z.literal(1),
    kdf: z.literal('scrypt'),
    N: z.number().int(),
    r: z.number().int(),
    p: z.number().int(),
    salt: z.string(),
    nonce: z.string(),
    ct: z.string(),
  })
  .strict();
export type KeyFileDoc = z.infer<typeof KeyFileSchema>;

/** Strict standard base64 of exactly `bytes` bytes, or `undefined` for anything else. */
export function decodeB64(text: string, bytes: number): Buffer | undefined {
  if (!B64.test(text)) return undefined;
  const decoded = Buffer.from(text, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === text
    ? decoded
    : undefined;
}

/**
 * Refuses an owner-key directory that is a symlink, not a directory, not owned by the current user, or
 * open to group or other: a directory others can write lets them rename or replace `owner.key`.
 *
 * @remarks Only the directory itself is `lstat`ed; a symlinked ancestor is followed, like the store's
 *   repository walk, until the canonical-path checks of Amendment 2026-11-02 section 3 arrive.
 * @throws {TrustError} `key_missing` when the directory does not exist; `trust_tampered` (detail
 *   `key_dir`) otherwise.
 */
export function assertKeyDir(keyDir: string): void {
  let st;
  try {
    st = lstatSync(keyDir);
  } catch {
    throw new TrustError(
      'key_missing',
      `No owner-key directory at ${keyDir}. Run: flowctl trust init`,
    );
  }
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.uid !== userInfo().uid ||
    (st.mode & 0o077) !== 0
  )
    throw new TrustError(
      'trust_tampered',
      `The owner-key directory ${keyDir} must be a real directory that you own with mode 0700.`,
      'key_dir',
    );
}

/**
 * Refuses when `<keyDir>/owner.key` exists in any form, a dangling symlink included, so a key is never
 * overwritten and the slow derivation never runs for nothing.
 *
 * @throws {TrustError} `key_exists`.
 */
export function assertNoKeyFile(
  keyDir: string,
  name: KeyFileName = KEY_FILE,
): void {
  const file = join(keyDir, name);
  try {
    lstatSync(file);
  } catch {
    return;
  }
  throw keyExists(file);
}

/**
 * Writes `owner.key` with `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` and mode 0400, then `fsync`s it. A failed
 * write removes the partial file, so it can never read back as `key_exists`.
 *
 * @throws {TrustError} `key_exists` when the file appeared meanwhile; `key_write_failed` otherwise.
 */
export function writeKeyFile(
  keyDir: string,
  doc: KeyFileDoc,
  name: KeyFileName = KEY_FILE,
): void {
  const file = join(keyDir, name);
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o400,
    );
  } catch (e) {
    if (errno(e) === 'EEXIST') throw keyExists(file);
    throw new TrustError(
      'key_write_failed',
      `Cannot create the owner key ${file}: ${describe(e)}`,
    );
  }
  let written = false;
  let cause = '';
  try {
    writeSync(fd, JSON.stringify(doc));
    fsyncSync(fd);
    written = true;
  } catch (e) {
    cause = describe(e);
  } finally {
    closeSync(fd);
  }
  if (!written) {
    rmSync(file, { force: true });
    throw new TrustError(
      'key_write_failed',
      `Writing the owner key ${file} failed (${cause}); the partial file was removed.`,
    );
  }
}

/**
 * Reads `owner.key` after checking its directory, opening it `O_NOFOLLOW` and `fstat`ing the descriptor:
 * a single-link regular file owned by the current user and closed to group and other.
 *
 * @throws {TrustError} `key_missing`; `trust_tampered` (detail `key_dir` or `key_file`) for a bad
 *   directory, a symlink, a hard link, another owner or loose mode bits; `key_unlock_failed` when the file
 *   cannot be read or is not JSON.
 */
export function readKeyFile(
  keyDir: string,
  name: KeyFileName = KEY_FILE,
): unknown {
  assertKeyDir(keyDir);
  const file = join(keyDir, name);
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    if (errno(e) === 'ENOENT')
      throw new TrustError(
        'key_missing',
        `No owner key at ${file}. Run: flowctl trust init`,
      );
    if (errno(e) === 'ELOOP')
      throw new TrustError(
        'trust_tampered',
        `The owner key ${file} is a symlink.`,
        'key_file',
      );
    throw new TrustError(
      'key_unlock_failed',
      `Cannot open the owner key ${file}: ${describe(e)}`,
    );
  }
  let text: string;
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
        `The owner key ${file} must be a single-link regular file that you own and that group and other cannot access (created 0400).`,
        'key_file',
      );
    text = readFileSync(fd, 'utf8');
  } catch (e) {
    if (e instanceof TrustError) throw e;
    throw new TrustError(
      'key_unlock_failed',
      `Cannot read the owner key ${file}: ${describe(e)}`,
    );
  } finally {
    closeSync(fd);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TrustError(
      'key_unlock_failed',
      `The owner key ${file} is not valid JSON.`,
    );
  }
}

const keyExists = (file: string): TrustError =>
  new TrustError(
    'key_exists',
    `An owner key already exists at ${file}; flowctl never overwrites it.`,
  );

const errno = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

const describe = (e: unknown): string => errno(e) ?? String(e);
