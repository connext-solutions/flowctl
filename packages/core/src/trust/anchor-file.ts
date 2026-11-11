import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { TrustError } from './errors.js';
import { assertNotInRepository } from './location.js';

/** What a backend call returned: its output, or why it failed (exit status, signal or error code). */
export type Ran = { ok: true; out: string } | { ok: false; why: string };

/**
 * The real directory an absolute `--anchor-dir` names, created 0700 when missing.
 *
 * @throws {TrustError} `trust_entry_invalid` when it is inside or around the store, or is not a directory this user
 *   owns that no one else can write; `trust_tampered` when it is inside a repository.
 */
export function anchorDirFor(anchorDir: string, storeDir: string): string {
  mkdirSync(resolve(anchorDir), { recursive: true, mode: 0o700 });
  const dir = realpathSync(anchorDir);
  const store = existsSync(storeDir)
    ? realpathSync(storeDir)
    : resolve(storeDir);
  if (
    dir === store ||
    dir.startsWith(`${store}/`) ||
    store.startsWith(`${dir}/`)
  )
    throw new TrustError(
      'trust_entry_invalid',
      `--anchor-dir must not be inside or around the store directory ${store}: one edit would otherwise change both copies of the head.`,
    );
  assertNotInRepository(dir);
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.uid !== userInfo().uid || (st.mode & 0o022) !== 0)
    throw new TrustError(
      'trust_entry_invalid',
      `--anchor-dir ${dir} must be a directory you own that no one else can write (mode 0700).`,
    );
  return dir;
}

/** Reads a file anchor with the store's checks: no symlink, one link, owned by this user, mode 0600. */
export function readAnchorFile(file: string): Ran {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    return {
      ok: false,
      why: `${file}: ${e instanceof Error && 'code' in e ? String(e.code) : 'cannot open'}`,
    };
  }
  try {
    const st = fstatSync(fd);
    if (
      !st.isFile() ||
      st.nlink !== 1 ||
      st.uid !== userInfo().uid ||
      (st.mode & 0o077) !== 0
    )
      return {
        ok: false,
        why: `${file} is not a private regular file of this user (mode 0600, one link)`,
      };
    return { ok: true, out: readFileSync(fd, 'utf8') };
  } finally {
    closeSync(fd);
  }
}

/** Replaces a file anchor atomically and durably (temp file 0600 `O_EXCL|O_NOFOLLOW`, rename, directory fsync). */
export function writeAnchorFile(file: string, text: string): Ran {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    const fd = openSync(
      tmp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      writeSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
    const dirFd = openSync(dirname(file), constants.O_RDONLY);
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
    return { ok: true, out: '' };
  } catch (e) {
    rmSync(tmp, { force: true });
    return {
      ok: false,
      why: `${file}: ${e instanceof Error && 'code' in e ? String(e.code) : 'cannot write'}`,
    };
  }
}
