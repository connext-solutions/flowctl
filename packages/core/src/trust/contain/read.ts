import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type Stats,
} from 'node:fs';
import { join, sep } from 'node:path';
import {
  checkRoot,
  type ContainedRoot,
  ContainmentError,
  containmentRefusal,
  splitRelative,
} from './root.js';

const missing = (rel: string): ContainmentError =>
  new ContainmentError(
    'not_found',
    'missing',
    `${JSON.stringify(rel)} does not exist`,
  );

const tooLarge = (rel: string, size: number, max: number): ContainmentError =>
  new ContainmentError(
    'too_large',
    'file size',
    `${JSON.stringify(rel)} is ${size} bytes; at most ${max} bytes are read`,
  );

const errno = (e: unknown): string | undefined =>
  e instanceof Error && 'code' in e && typeof e.code === 'string'
    ? e.code
    : undefined;

/**
 * `lstat`s every component from the root down: no link anywhere, directories above, a regular file with link
 * count 1 at the end.
 *
 * @returns the absolute path and the final component's `lstat`.
 */
function walkChain(
  root: ContainedRoot,
  rel: string,
  parts: string[],
): { path: string; st: Stats } {
  let at = root.path;
  let st: Stats | undefined;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    try {
      st = lstatSync(at);
    } catch (e) {
      if (errno(e) === 'ENOENT' || errno(e) === 'ENOTDIR') throw missing(rel);
      throw e;
    }
    if (st.isSymbolicLink()) throw containmentRefusal(rel, 'no symbolic link');
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory())
      throw containmentRefusal(rel, 'must be a directory');
  }
  if (st === undefined || !st.isFile())
    throw containmentRefusal(rel, 'must be a regular file');
  if (st.nlink !== 1) throw containmentRefusal(rel, 'no hard link');
  if (!at.startsWith(`${root.path}${sep}`))
    throw containmentRefusal(rel, 'inside the root');
  return { path: at, st };
}

/**
 * Reads the file `rel` names inside `root` with the containment rules of ADR 0023 rule 3 and ADR 0024 section 1a
 * (rules 1, 5, 6, 7 and 9):
 * - the lexical checks of {@link splitRelative} (no `..`, absolute, dot-prefixed, Windows or non-NFC component);
 * - the root is still the directory that was opened, and every component below it is `lstat`-ed: no link, a
 *   regular file with link count 1 at the end (a hard link out of the root is refused on purpose);
 * - opened with `O_NOFOLLOW` and `O_NONBLOCK` (a FIFO swapped in cannot block the read); the descriptor is a
 *   regular file with link count 1 whose device and inode match the checked path, so a directory or file swapped
 *   between the check and the open is refused;
 * - at most `maxBytes`, checked before the open and on the descriptor; a file that grows while it is read is
 *   refused.
 *
 * @example
 *   const root = openRoot('/abs/specs', 'specs');
 *   const bytes = readContained(root, 'leave/submit.md', { maxBytes: 1024 * 1024 });
 * @throws {ContainmentError} `path_not_contained` with the rule that failed, `not_found`, or `too_large`.
 */
export function readContained(
  root: ContainedRoot,
  rel: string,
  opts: { maxBytes: number },
): Buffer {
  const parts = splitRelative(rel);
  checkRoot(root);
  const { path, st: before } = walkChain(root, rel, parts);
  if (before.size > opts.maxBytes)
    throw tooLarge(rel, before.size, opts.maxBytes);
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    if (errno(e) === 'ELOOP') throw containmentRefusal(rel, 'no symbolic link');
    if (errno(e) === 'ENOENT') throw missing(rel);
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino)
      throw containmentRefusal(rel, 'the file changed while it was checked');
    if (st.nlink !== 1) throw containmentRefusal(rel, 'no hard link');
    if (st.size > opts.maxBytes) throw tooLarge(rel, st.size, opts.maxBytes);
    const buffer = Buffer.alloc(st.size + 1);
    let read = 0;
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, read);
      if (n === 0) break;
      read += n;
    }
    if (read > st.size)
      throw containmentRefusal(rel, 'the file changed while it was read');
    checkRoot(root);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}
