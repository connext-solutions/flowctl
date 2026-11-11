import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
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

const PID = /^([1-9][0-9]{0,9})\n?$/;

/** Whether process `pid` exists: `EPERM` means it does, under another user. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return !isCode(e, 'ESRCH');
  }
}

/**
 * The holder of the lock file at `path`: `gone` when the file vanished, `stale` when its pid is not a live process (or
 * it held no pid for {@link UNWRITTEN_MS}), else the pid or `unknown` (a link, a FIFO, a file being written), which
 * counts as held.
 */
function holder(path: string): 'gone' | 'stale' | 'unknown' | number {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    return isCode(e, 'ENOENT') ? 'gone' : 'unknown';
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) return 'unknown';
    const buf = Buffer.alloc(16);
    const text = buf.subarray(0, readSync(fd, buf, 0, 16, 0)).toString();
    const pid = PID.exec(text)?.[1];
    if (pid === undefined)
      return Date.now() - st.mtimeMs < UNWRITTEN_MS ? 'unknown' : 'stale';
    return alive(Number(pid)) ? Number(pid) : 'stale';
  } finally {
    closeSync(fd);
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
   * @returns the lock, and `stale: true` when a stale lock was removed first.
   * @throws {TrustError} `ledgers_invalid` `busy` while a live process holds it.
   */
  static take(
    dir: string,
    runId: string,
  ): { lock: LedgerLock; stale: boolean } {
    const path = join(dir, `${runId}.lock`);
    let stale = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const fd = openSync(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        );
        try {
          writeSync(fd, `${process.pid}\n`);
        } finally {
          closeSync(fd);
        }
        return { lock: new LedgerLock(path), stale };
      } catch (e) {
        if (!isCode(e, 'EEXIST')) throw e;
      }
      const h = holder(path);
      if (stale || attempt > 1 || (h !== 'stale' && h !== 'gone'))
        throw invalid(
          'busy',
          `Another flowctl process${typeof h === 'number' ? ` (pid ${h})` : ''} is using the ledger of run ${runId} (a live run or a cleanup); nothing was sent. Wait for it to end and try again; if no flowctl process runs, remove ${path}.`,
        );
      if (h === 'stale') {
        try {
          unlinkSync(path);
        } catch (e) {
          if (!isCode(e, 'ENOENT')) throw e;
        }
        stale = true;
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
