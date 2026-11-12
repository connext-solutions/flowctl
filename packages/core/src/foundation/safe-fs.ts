import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { ConfigError } from './names.js';

const symlinkError = (path: string): ConfigError =>
  new ConfigError(
    `${path} is a symlink; flowctl never writes through links there. Remove the symlink and run again.`,
  );

/**
 * Creates `dir` under `root` one component at a time, refusing any existing component that is a
 * symlink or not a directory, so nothing written there can land outside `root`.
 *
 * @param root the flows directory; it may itself be a symlink (a linked flows repo), which is
 *   resolved once.
 * @param opts.mode mode for created directories, also applied to `dir` when it already exists.
 * @param opts.gitignoreAll write `<dir>/.gitignore` with `*` when it has none, so session files and
 *   evidence are never committed by accident.
 * @returns the real path of `dir`.
 * @throws {ConfigError} when a component is a symlink or a file, or `dir` is not under `root`.
 */
export function ensureDirInside(
  dir: string,
  root: string,
  opts: { mode?: number; gitignoreAll?: boolean } = {},
): string {
  const rel = relative(resolve(root), resolve(dir));
  if (rel.startsWith('..') || isAbsolute(rel))
    throw new ConfigError(`${dir} is not inside ${root}`);
  mkdirSync(root, { recursive: true });
  let current = realpathSync(root);
  for (const part of rel.split(/[\\/]/).filter(Boolean)) {
    current = join(current, part);
    if (existsSync(current) || isLink(current)) {
      const st = lstatSync(current);
      if (st.isSymbolicLink()) throw symlinkError(join(root, rel));
      if (!st.isDirectory())
        throw new ConfigError(`${current} exists and is not a directory`);
    } else {
      mkdirSync(current, { mode: opts.mode });
    }
  }
  if (opts.mode !== undefined) chmodSync(current, opts.mode);
  const ignore = join(current, '.gitignore');
  if (opts.gitignoreAll === true && !existsSync(ignore) && !isLink(ignore))
    writeFileNoFollow(ignore, '*\n');
  return current;
}

/**
 * Writes `path` by writing a temp file in the same directory and renaming it over `path`: a symlink
 * at `path` is replaced, its target is never written.
 *
 * @param mode file mode (e.g. `0o600` for session cookies); the default umask applies otherwise.
 */
export function writeFileNoFollow(
  path: string,
  data: string | Uint8Array,
  mode?: number,
): void {
  const tmp = join(
    dirname(path),
    `.${basename(path)}.${randomBytes(4).toString('hex')}.tmp`,
  );
  try {
    writeFileSync(tmp, data, { flag: 'wx', mode: mode ?? 0o666 });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Refuses a path that is a symlink; a missing path passes.
 *
 * @throws {ConfigError} when `path` is a symlink.
 */
export function assertNotSymlink(path: string): void {
  if (isLink(path)) throw symlinkError(path);
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Why {@link readFileNoFollow} could not read a file. The message is a fixed reason (`a symlink`, `not a regular
 * file`, `larger than <n> bytes`) or the error code alone (`ENOENT`, `EACCES`): never the file's text and never the
 * fs message, so it is safe to print.
 */
export class NoFollowReadError extends Error {
  override readonly name = 'NoFollowReadError';
}

const errCode = (e: unknown): string => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && /^E[A-Z]+$/.test(code)
    ? code
    : 'unreadable';
};

/**
 * Reads the regular file `path` as UTF-8: opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (a link at the end is refused, a
 * FIFO cannot block), then `fstat`ed and read from the descriptor, so what is checked is what is read.
 *
 * @throws {NoFollowReadError} when `path` is a symlink, missing, not a regular file, larger than `maxBytes` (on the
 *   descriptor, and while it is read) or unreadable.
 */
export function readFileNoFollow(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    throw new NoFollowReadError(
      errCode(e) === 'ELOOP' ? 'a symlink' : errCode(e),
    );
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new NoFollowReadError('not a regular file');
    const tooLarge = new NoFollowReadError(`larger than ${maxBytes} bytes`);
    if (st.size > maxBytes) throw tooLarge;
    const buffer = Buffer.alloc(st.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read > maxBytes) throw tooLarge;
    return buffer.subarray(0, read).toString('utf8');
  } catch (e) {
    throw e instanceof NoFollowReadError
      ? e
      : new NoFollowReadError(errCode(e));
  } finally {
    closeSync(fd);
  }
}
