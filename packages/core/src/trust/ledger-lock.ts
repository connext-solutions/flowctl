import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import type { TrustError } from './errors.js';
import { invalid } from './ledger-lines.js';
import { isCode } from './store-fs.js';

/**
 * Checks `<store>/ledgers` as ADR 0025 amendment 2026-11-02 section 4 says: a directory (not a link), owned by this
 * user, mode exactly 0700.
 *
 * @throws {TrustError} `ledgers_invalid` with detail `not_directory`, `owner` or `mode`.
 */
export function ledgersDir(storeDir: string): string {
  const dir = join(storeDir, 'ledgers');
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    throw invalid(
      'not_directory',
      `${dir} is missing; the trust store has no ledgers directory.`,
    );
  }
  if (!st.isDirectory())
    throw invalid('not_directory', `${dir} is not a directory.`);
  if (st.uid !== process.geteuid?.())
    throw invalid('owner', `${dir} is not owned by this user.`);
  if ((st.mode & 0o777) !== 0o700)
    throw invalid('mode', `${dir} must have mode 0700.`);
  return dir;
}

/** How long a lock file that holds no pid yet counts as one being written (not stale). */
const UNWRITTEN_MS = 10_000;

/** How long a takeover file counts as held: a takeover lasts a few file calls, so an older one was left by a crash. */
const TAKEOVER_MS = 30_000;

const PID = /^([1-9][0-9]{0,9})\n?$/;

/**
 * The read of a lock file, apart so a test can run a second takeover between two steps of the first. Production code
 * never changes it.
 *
 * @internal
 */
export const LOCK_IO = {
  read: (fd: number, buf: Buffer): number =>
    readSync(fd, buf, 0, buf.length, 0),
};

/** Whether process `pid` exists: `EPERM` means it does, under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !isCode(e, 'ESRCH');
  }
}

/** Which file a lock path held: device, inode and change time, so a file put in its place is told apart. */
const identity = (st: Stats): string => `${st.dev}:${st.ino}:${st.ctimeMs}`;

/** The identity of the file at `path` now, `undefined` when there is none. */
function identityNow(path: string): string | undefined {
  try {
    return identity(lstatSync(path));
  } catch (e) {
    if (isCode(e, 'ENOENT')) return undefined;
    throw e;
  }
}

/** Who holds a lock file, and which file was judged. */
interface Holder {
  who: 'gone' | 'stale' | 'unknown' | number;
  file?: string;
}

/**
 * The holder of the lock file at `path`: `gone` when the file vanished, `stale` when its pid is not a live process (or
 * it held no pid for {@link UNWRITTEN_MS}), else the pid or `unknown` (a link, a FIFO, a file being written), which
 * counts as held. `file` is the identity of the file read, taken on the open descriptor.
 */
function holder(path: string): Holder {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    return { who: isCode(e, 'ENOENT') ? 'gone' : 'unknown' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return { who: 'unknown' };
    const buf = Buffer.alloc(16);
    const text = buf.subarray(0, LOCK_IO.read(fd, buf)).toString();
    const pid = PID.exec(text)?.[1];
    const file = identity(st);
    if (pid === undefined)
      return {
        who: Date.now() - st.mtimeMs < UNWRITTEN_MS ? 'unknown' : 'stale',
        file,
      };
    return { who: alive(Number(pid)) ? Number(pid) : 'stale', file };
  } finally {
    closeSync(fd);
  }
}

/** Creates `path` with `O_EXCL` and mode 0600, writing `text`. @throws the `EEXIST` error when it exists. */
function createExcl(path: string, text: string): void {
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
  } finally {
    closeSync(fd);
  }
}

/** Removes `path`; a file already gone is fine. */
function unlinkGone(path: string): void {
  try {
    unlinkSync(path);
  } catch (e) {
    if (!isCode(e, 'ENOENT')) throw e;
  }
}

/**
 * Takes `<lock>.takeover` with `O_EXCL`; one older than {@link TAKEOVER_MS} is removed first (a crash mid-takeover).
 *
 * @returns whether it was taken: `false` while another process takes the same lock over.
 */
function takeTakeover(path: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      createExcl(path, `${process.pid}\n`);
      return true;
    } catch (e) {
      if (!isCode(e, 'EEXIST')) throw e;
    }
    let mtimeMs: number;
    try {
      mtimeMs = lstatSync(path).mtimeMs;
    } catch (e) {
      if (isCode(e, 'ENOENT')) continue;
      throw e;
    }
    if (Date.now() - mtimeMs < TAKEOVER_MS) return false;
    unlinkGone(path);
  }
  return false;
}

/**
 * Removes the stale lock at `path` that {@link holder} judged as `judged`, under `<path>.takeover`: while holding it,
 * the lock is judged again and must still be stale and still be the same file (its identity on the descriptor read
 * and by `lstat` now), so a fresh lock another process created meanwhile is never removed.
 *
 * @returns `removed` when the stale lock was removed, `changed` when the path now holds another file or none (the
 *   caller tries to create the lock again), `busy` while another takeover runs.
 */
function takeOver(
  path: string,
  judged: string,
): 'removed' | 'changed' | 'busy' {
  const takeover = `${path}.takeover`;
  if (!takeTakeover(takeover)) return 'busy';
  try {
    const again = holder(path);
    if (again.who !== 'stale' || again.file !== judged) return 'changed';
    if (identityNow(path) !== judged) return 'changed';
    unlinkGone(path);
    return 'removed';
  } finally {
    unlinkGone(takeover);
  }
}

/**
 * The lock of one run's ledger, `<store>/ledgers/<run id>.lock` (mode 0600, created with `O_EXCL`, holding the pid):
 * the live run holds it from the ledger's creation to its close, and `flowctl cleanup` while it reads and appends, so
 * two writers never extend the same hash chain or send the same `DELETE` twice.
 */
export class LedgerLock {
  private released = false;

  private constructor(readonly path: string) {}

  /**
   * Takes the lock of `runId` in the ledgers directory `dir`. A lock whose process is gone is removed and taken over.
   *
   * @remarks The takeover runs under a second `O_EXCL` file, `<run id>.lock.takeover` (see {@link takeOver}); two
   *   processes taking over the same stale lock never remove each other's fresh lock. The loop is bounded: three
   *   creates at most.
   * @returns the lock, and `stale: true` when a stale lock was removed first.
   * @throws {TrustError} `ledgers_invalid` `busy` while a live process holds it or another takes it over.
   */
  static take(
    dir: string,
    runId: string,
  ): { lock: LedgerLock; stale: boolean } {
    const path = join(dir, `${runId}.lock`);
    let stale = false;
    for (let attempt = 0; ; attempt++) {
      try {
        createExcl(path, `${process.pid}\n`);
        return { lock: new LedgerLock(path), stale };
      } catch (e) {
        if (!isCode(e, 'EEXIST')) throw e;
      }
      const h = holder(path);
      const busy = (): TrustError =>
        invalid(
          'busy',
          `Another flowctl process${typeof h.who === 'number' ? ` (pid ${h.who})` : ''} is using the ledger of run ${runId} (a live run or a cleanup); nothing was sent. Wait for it to end and try again; if no flowctl process runs, remove ${path}.`,
        );
      if (stale || attempt > 1 || (h.who !== 'stale' && h.who !== 'gone'))
        throw busy();
      if (h.who === 'stale' && h.file !== undefined) {
        const taken = takeOver(path, h.file);
        if (taken === 'busy') throw busy();
        if (taken === 'removed') stale = true;
      }
    }
  }

  /** Removes the lock file once. */
  release(): void {
    if (this.released) return;
    this.released = true;
    try {
      unlinkSync(this.path);
    } catch (e) {
      if (!isCode(e, 'ENOENT')) throw e;
    }
  }
}
