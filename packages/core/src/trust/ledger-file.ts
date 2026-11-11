import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
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
import { fsyncDir, isCode } from './store-fs.js';

export {
  type LedgerLine,
  LedgerLineSchema,
  type NewLedgerLine,
  RUN_ID_PATTERN,
} from './ledger-lines.js';

/** The largest ledger file read back: 500 ids with their lines and cleanup lines fit many times over. */
const MAX_LEDGER_BYTES = 4 * 1024 * 1024;

/**
 * Checks `<store>/ledgers` as ADR 0025 amendment 2026-11-02 section 4 says: a directory (not a link), owned by this
 * user, mode exactly 0700.
 *
 * @throws {TrustError} `ledgers_invalid` with detail `not_directory`, `owner` or `mode`.
 */
function ledgersDir(storeDir: string): string {
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

/**
 * The authoritative ledger of one run, `<store>/ledgers/<run id>.jsonl` (ADR 0024 section 5, ledger rule 9; ADR 0025
 * amendment 2026-11-02 section 4): mode 0600, one JSON line each, every line carrying the sha256 of the previous one,
 * every append written and fsynced before it returns.
 */
export class LedgerFile {
  private closed = false;

  private constructor(
    private readonly fd: number,
    private prev: string,
    readonly path: string,
  ) {}

  /**
   * Creates the ledger of `runId` with `O_EXCL` and writes its header line.
   *
   * @throws {RunError} `ledger_exists` when a file of that name exists; the run ends before its first request.
   * @throws {TrustError} `ledgers_invalid` when the ledgers directory is not as it must be.
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
      if (isCode(e, 'EEXIST'))
        throw new RunError(
          'ledger_exists',
          `The ledger ${path} already exists, so this run cannot keep its own; nothing was sent. Run the flow again (a new run gets a new id).`,
        );
      throw e;
    }
    const file = new LedgerFile(fd, ZERO, path);
    file.append({ v: 1, kind: 'ledger-header', runId, bundleId });
    fsyncDir(dir);
    return file;
  }

  /**
   * Opens the ledger of `runId` to read it and append to it (`flowctl cleanup`): the file is opened without following
   * a link and without blocking, checked to be a regular file of this user with one link, and its hash chain, header,
   * run id and bundle id verified.
   *
   * @remarks A torn last line (see `verifyChain`) is cut off the file, so the next append starts a line of its own,
   *   and `torn` is `true`; a complete last line that lost only its `\n` gets it back.
   *
   * @throws {TrustError} `ledgers_invalid` (`not_directory`, `owner`, `mode`, `not_regular`, `chain`, `foreign`);
   *   `trust_entry_invalid` when no ledger has that run id.
   */
  static open(
    storeDir: string,
    runId: string,
    bundleId: string | null,
  ): { file: LedgerFile; lines: LedgerLine[]; torn: boolean } {
    const dir = ledgersDir(storeDir);
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
      const file = new LedgerFile(fd, head, path);
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
   * @throws {TrustError} `ledgers_invalid` `closed` after {@link close}: a write that answers after the run's ledger
   *   ended is never recorded, and its intent stays unconfirmed.
   */
  append(line: NewLedgerLine): void {
    if (this.closed)
      throw invalid(
        'closed',
        `The ledger ${this.path} is closed; nothing more is recorded in it.`,
      );
    const text = JSON.stringify({ ...line, prev: this.prev });
    this.write(Buffer.from(`${text}\n`));
    fsyncSync(this.fd);
    this.prev = sha(text);
  }

  /**
   * Writes all of `buf`: `writeSync` may write part of it, so it is called again for the rest.
   *
   * @throws {TrustError} `ledgers_invalid` `short_write` when the file takes no byte.
   */
  private write(buf: Buffer): void {
    let done = 0;
    while (done < buf.length) {
      const n = writeSync(this.fd, buf, done, buf.length - done);
      if (n <= 0)
        throw invalid('short_write', `${this.path} took no byte of a line.`);
      done += n;
    }
  }

  /** Closes the file once; appending afterwards throws. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.fd);
  }
}
