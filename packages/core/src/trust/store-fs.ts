import { randomBytes } from 'node:crypto';
import dayjs from 'dayjs';
import {
  closeSync,
  constants,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { TrustError } from './errors.js';
import { lineText, type LogLine } from './log.js';
import { type TrustStoreDoc, TrustStoreSchema } from './schema.js';

/** The store lock, next to `trust.json`; the helpers here are shared by `write.ts` and the rotation. */
const LOCK_FILE = 'trust.lock';

/** True when `e` is a Node file-system error with `code`. */
export const isCode = (e: unknown, code: string): boolean =>
  e instanceof Error && 'code' in e && e.code === code;

/** The text of `trust.log` holding `lines`, one canonical line each. */
export const logText = (lines: LogLine[]): string =>
  lines.map((l) => `${lineText(l)}\n`).join('');

/**
 * Takes the store lock: `trust.lock`, holding this process id, appears in one step (written to a temp file, then
 * hard-linked into place, which fails if the lock exists). A lock is never taken over automatically: trust commands
 * are interactive, so a person decides whether a leftover lock is stale.
 *
 * @returns the function that releases it.
 * @throws {TrustError} `store_busy` naming the lock file and the process id it records, with when it is safe to
 *   delete it; `store_unreadable` when the lock cannot be created for another reason.
 */
export function lock(dir: string): () => void {
  const file = join(dir, LOCK_FILE);
  const tmp = join(dir, `.${LOCK_FILE}.${randomBytes(6).toString('hex')}.tmp`);
  writeExclusive(tmp, `${process.pid}\n`);
  try {
    linkSync(tmp, file);
  } catch (e) {
    if (!isCode(e, 'EEXIST'))
      throw new TrustError(
        'store_unreadable',
        `Cannot create the trust store lock ${file}: ${String(e)}`,
      );
    throw new TrustError(
      'store_busy',
      `Another flowctl command (process ${holder(file)}) is changing the trust store in ${dir}. Wait for it to finish and run this command again; if no flowctl command is running, delete ${file} by hand.`,
    );
  } finally {
    rmSync(tmp, { force: true });
  }
  return () => {
    try {
      rmSync(file, { force: true });
    } catch {
      return;
    }
  };
}

/** The process id a lock file records, or `unknown`. */
function holder(file: string): string {
  try {
    const pid = readFileSync(file, 'utf8').trim();
    return /^[0-9]{1,10}$/.test(pid) ? pid : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** `fsync`s a directory, so a rename in it is durable before the next step depends on it. */
export function fsyncDir(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Replaces `<dir>/<name>` atomically with `text` (temp file, rename, directory fsync). */
export function replaceFile(dir: string, name: string, text: string): void {
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  writeExclusive(tmp, text);
  try {
    renameSync(tmp, join(dir, name));
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  fsyncDir(dir);
}

/** The document as the schema reads it back (defaults applied), so the digest a log line records is the one a read computes. */
export function normalize(doc: TrustStoreDoc): TrustStoreDoc {
  const parsed = TrustStoreSchema.safeParse(doc);
  if (!parsed.success)
    throw new TrustError(
      'trust_entry_invalid',
      'flowctl refused to write a trust store that does not match its schema.',
    );
  return parsed.data;
}

/** The text of `trust.json` for `doc` committed at `head`. */
export const serialize = (doc: TrustStoreDoc, head: string): string =>
  `${JSON.stringify({ ...doc, head }, null, 2)}\n`;

/** Creates `path` with `text`, mode 0600, `O_EXCL|O_NOFOLLOW`, and `fsync`s it; an existing file is an error. */
export function writeExclusive(path: string, text: string): void {
  const fd = openSync(
    path,
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
}

/** Bound on the `<n>` of a dated name; a directory never holds that many. */
const MAX_DATED = 1000;

/**
 * `<stem><UTC date>.<n>` with the smallest `n` from 1 whose path in `dir` does not exist, so no earlier file or
 * directory is overwritten (ADR 0025 Amendment 2026-11-02 sections 5 and 6).
 *
 * @example datedName(keyDir, 'owner.key.retired-') // 'owner.key.retired-2026-11-02.1'
 * @throws {TrustError} `key_write_failed` when every name up to the bound is taken.
 */
export function datedName(dir: string, stem: string): string {
  const day = dayjs().toISOString().slice(0, 10);
  for (let n = 1; n <= MAX_DATED; n++) {
    const name = `${stem}${day}.${n}`;
    try {
      lstatSync(join(dir, name));
    } catch {
      return name;
    }
  }
  throw new TrustError(
    'key_write_failed',
    `More than ${MAX_DATED} names ${stem}${day}.<n> exist in ${dir}; move some away.`,
  );
}
