import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { RunError } from '../foundation/index.js';
import {
  invalid,
  type LedgerLine,
  type NewLedgerLine,
  RUN_ID_PATTERN,
  sha,
  verifyChain,
} from './ledger-lines.js';
import { ZERO } from './log.js';
import { TrustError } from './errors.js';
import { LedgerLock, ledgersDir } from './ledger-lock.js';
import { fsyncDir, isCode } from './store-fs.js';

export {
  type LedgerLine,
  LedgerLineSchema,
  type NewLedgerLine,
  RUN_ID_PATTERN,
} from './ledger-lines.js';

/**
 * The two calls an append makes, apart so a test can make one fail (a full disk, a failing fsync) without a real
 * device. Production code never changes them.
 */
export const LEDGER_IO = {
  write: (fd: number, buf: Buffer, offset: number, length: number): number =>
    writeSync(fd, buf, offset, length),
  fsync: (fd: number): void => fsyncSync(fd),
};

/** The largest ledger file read back: 500 ids with their lines and cleanup lines fit many times over. */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

/**
 * The authoritative ledger of one run, `<store>/ledgers/<run id>.jsonl` (ADR 0024 section 5, ledger rule 9; ADR 0025
 * amendment 2026-11-02 section 4): mode 0600, one JSON line each, every line carrying the sha256 of the previous one,
 * every append written and fsynced before it returns.
 */
export class LedgerFile {
  private closed = false;
  /** Set by the first append that failed: the file takes no more lines. */
  private failed = false;

  private constructor(
    private readonly fd: number,
    private prev: string,
    readonly path: string,
    readonly runId: string,
    private readonly lock: LedgerLock,
  ) {}

  /**
   * Creates the ledger of `runId` with `O_EXCL` and writes its header line.
   *
   * @remarks It takes the run's lock first ({@link LedgerLock}) and keeps it until {@link close}.
   * @throws {RunError} `ledger_exists` when a file of that name exists; the run ends before its first request.
   * @throws {TrustError} `ledgers_invalid` when the ledgers directory is not as it must be, or `busy` when another
   *   process holds the run's lock.
   */
  static create(
    storeDir: string,
    runId: string,
    bundleId: string | null,
  ): LedgerFile {
    if (!RUN_ID_PATTERN.test(runId))
      throw new RunError('internal', `"${runId.slice(0, 40)}" is not a run id`);
    const dir = ledgersDir(storeDir);
    const path = join(dir, `${runId}.jsonl`);
    const { lock } = LedgerLock.take(dir, runId);
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (e) {
      lock.release();
      if (isCode(e, 'EEXIST'))
        throw new RunError(
          'ledger_exists',
          `The ledger ${path} already exists, so this run cannot keep its own; nothing was sent. Run the flow again (a new run gets a new id).`,
        );
      throw e;
    }
    const file = new LedgerFile(fd, ZERO, path, runId, lock);
    try {
      file.append({ v: 1, kind: 'ledger-header', runId, bundleId });
      fsyncDir(dir);
    } catch (e) {
      file.close();
      throw e;
    }
    return file;
  }

  /**
   * Opens the ledger of `runId` to read it and append to it (`flowctl cleanup`): the file is opened without following
   * a link and without blocking, checked to be a regular file of this user with one link, and its hash chain, header,
   * run id and bundle id verified.
   *
   * @remarks A torn last line (see `verifyChain`) is cut off the file, so the next append starts a line of its own,
   *   and `torn` is `true`; a complete last line that lost only its `\n` gets it back. The run's lock is taken first
   *   and kept until {@link close}; `staleLock` is `true` when a lock left by a process that is gone was taken over.
   *
   * @throws {TrustError} `ledgers_invalid` (`not_directory`, `owner`, `mode`, `busy`, `not_regular`, `chain`,
   *   `foreign`); `trust_entry_invalid` when no ledger has that run id.
   */
  static open(
    storeDir: string,
    runId: string,
    bundleId: string | null,
  ): {
    file: LedgerFile;
    lines: LedgerLine[];
    torn: boolean;
    staleLock?: true;
  } {
    const dir = ledgersDir(storeDir);
    const { lock, stale } = LedgerLock.take(dir, runId);
    try {
      const opened = LedgerFile.read(dir, runId, bundleId, lock);
      return stale ? { ...opened, staleLock: true } : opened;
    } catch (e) {
      lock.release();
      throw e;
    }
  }

  /** The body of {@link open} once the lock is held. */
  private static read(
    dir: string,
    runId: string,
    bundleId: string | null,
    lock: LedgerLock,
  ): { file: LedgerFile; lines: LedgerLine[]; torn: boolean } {
    const path = join(dir, `${runId}.jsonl`);
    let fd: number;
    try {
      fd = openSync(
        path,
        constants.O_RDWR |
          constants.O_APPEND |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK,
      );
    } catch (e) {
      if (isCode(e, 'ENOENT'))
        throw new TrustError(
          'trust_entry_invalid',
          `There is no ledger for run ${runId} in ${dir}.`,
        );
      throw invalid(
        'not_regular',
        `${path} cannot be opened as a regular file.`,
      );
    }
    try {
      const st = fstatSync(fd);
      if (
        !st.isFile() ||
        st.nlink !== 1 ||
        st.uid !== process.geteuid?.() ||
        st.size > MAX_LEDGER_BYTES
      )
        throw invalid(
          'not_regular',
          `${path} is not a regular file of this user with one link.`,
        );
      const buf = Buffer.alloc(st.size);
      let read = 0;
      while (read < st.size) {
        const n = readSync(fd, buf, read, st.size - read, read);
        if (n === 0) break;
        read += n;
      }
      const bytes = buf.subarray(0, read);
      const { lines, head, torn } = verifyChain(
        bytes.toString('utf8'),
        runId,
        bundleId,
        path,
      );
      const file = new LedgerFile(fd, head, path, runId, lock);
      if (torn) ftruncateSync(fd, bytes.lastIndexOf(0x0a) + 1);
      else if (bytes.at(-1) !== 0x0a) file.write(Buffer.from('\n'));
      fsyncSync(fd);
      return { file, lines, torn };
    } catch (e) {
      closeSync(fd);
      throw e;
    }
  }

  /**
   * Appends `line` with `prev`, then fsyncs; returns only once the whole line is on disk.
   *
   * @remarks When the write or the fsync fails, the file is cut back to its length before the line (when that still
   *   works), so its chain stays whole, and it takes no more lines: a later line would follow one that is not on disk.
   * @throws {TrustError} `ledgers_invalid` `closed` after {@link close}: a write that answers after the run's ledger
   *   ended is never recorded, and its intent stays unconfirmed. `write_failed` for the append that failed and every
   *   later one.
   */
  append(line: NewLedgerLine): void {
    if (this.closed)
      throw invalid(
        'closed',
        `The ledger ${this.path} is closed; nothing more is recorded in it.`,
      );
    if (this.failed) throw this.writeFailed('an earlier line failed');
    const text = JSON.stringify({ ...line, prev: this.prev });
    let good: number | undefined;
    try {
      good = fstatSync(this.fd).size;
      this.write(Buffer.from(`${text}\n`));
      LEDGER_IO.fsync(this.fd);
    } catch (e) {
      this.failed = true;
      if (good !== undefined) cutBack(this.fd, good);
      throw this.writeFailed(e instanceof Error ? e.message : String(e));
    }
    this.prev = sha(text);
  }

  /** The `write_failed` refusal, naming the cause and what to do about the records left. */
  private writeFailed(why: string): TrustError {
    return invalid(
      'write_failed',
      `Writing the ledger ${this.path} failed (${why.slice(0, 200)}); it takes no more lines. Records this run created may be left: once the disk is fixed, run flowctl cleanup ${this.runId}.`,
    );
  }

  /**
   * Writes all of `buf`: `writeSync` may write part of it, so it is called again for the rest.
   *
   * @throws {TrustError} `ledgers_invalid` `short_write` when the file takes no byte.
   */
  private write(buf: Buffer): void {
    let done = 0;
    while (done < buf.length) {
      const n = LEDGER_IO.write(this.fd, buf, done, buf.length - done);
      if (n <= 0)
        throw invalid('short_write', `${this.path} took no byte of a line.`);
      done += n;
    }
  }

  /** Closes the file once and releases the run's lock; appending afterwards throws. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      closeSync(this.fd);
    } finally {
      this.lock.release();
    }
  }
}

/** Cuts `fd` back to `length`; when that fails too, the torn tail stays and `flowctl cleanup` drops it. */
function cutBack(fd: number, length: number): void {
  try {
    ftruncateSync(fd, length);
  } catch {
    return;
  }
}
