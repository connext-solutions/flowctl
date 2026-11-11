import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { basename, extname, join, sep } from 'node:path';
import { FlowError } from './errors.js';

/** The folder under a flows root that uploads come from (ADR 0024 section 1a rule 5); there is no config key for it. */
export const FIXTURES_DIR = 'fixtures';
/** The largest file an upload step reads, in bytes (ADR 0024 section 1a rule 10). */
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

/** What `setInputFiles` receives: the bytes flowctl read, never a path the browser could open itself. */
export interface FixtureFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.zip': 'application/zip',
  '.doc': 'application/msword',
  '.docx':
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const refuse = (file: string, rule: string): FlowError =>
  new FlowError(
    `upload: ${file} is refused (path_not_contained: ${rule}); put the file under ${FIXTURES_DIR}/ in the flows directory and name it relative to that directory, e.g. ${FIXTURES_DIR}/cv.pdf`,
  );

/**
 * Reads an upload file named relative to `flowsRoot`, under its `fixtures/` folder, with the containment rules of
 * ADR 0024 section 1a (rules 5, 6, 7, 9 and 10):
 * - relative, `/`-separated, starting with `fixtures/`, with no empty, `.`, `..` or dot-prefixed component (so no
 *   dotfile, `.git`, `.auth` or `.runs` in any case);
 * - every component from the flows root down is a real directory (no symlink), and the file a regular file;
 * - opened with `O_NOFOLLOW`; the descriptor is a regular file with link count 1 whose device and inode match the
 *   path's `lstat`, at most {@link MAX_UPLOAD_BYTES};
 * - the bytes are returned, so the browser never opens a path itself.
 *
 * @param flowsDir the flows directory; it may itself be a link (a linked flows repo), resolved once.
 * @remarks Node has no portable way to read a descriptor's own path (`F_GETPATH`), so rule 10's re-check of the
 *   opened path is the device and inode match against the `lstat` of the checked path; a same-user swap between the
 *   `lstat` walk and the open is then refused by `O_NOFOLLOW` (a link) or the match (another file).
 * @throws {FlowError} `path_not_contained` with the rule that failed, never the file's content; or when the file is
 *   missing, too large or unreadable.
 */
export function readFixture(flowsDir: string, file: string): FixtureFile {
  const flowsRoot = realpathSync(flowsDir);
  const parts = file.split('/');
  if (
    file.includes('\\') ||
    file.includes('\0') ||
    file.startsWith('/') ||
    parts[0] !== FIXTURES_DIR ||
    parts.length < 2
  )
    throw refuse(file, `must start with ${FIXTURES_DIR}/`);
  if (parts.some((p) => p === '' || p.startsWith('.')))
    throw refuse(file, 'no empty, dot or dot-prefixed component');
  let at = flowsRoot;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      throw new FlowError(
        `upload: ${file} does not exist; put it under ${FIXTURES_DIR}/ in the flows directory`,
      );
    }
    if (st.isSymbolicLink()) throw refuse(file, 'no symbolic link');
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory())
      throw refuse(
        file,
        last ? 'must be a regular file' : 'must be a directory',
      );
  }
  const path = join(flowsRoot, ...parts);
  if (!path.startsWith(`${flowsRoot}${sep}`))
    throw refuse(file, 'inside the flows root');
  const before = lstatSync(path);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== before.dev || st.ino !== before.ino)
      throw refuse(file, 'the file changed while it was checked');
    if (st.nlink !== 1) throw refuse(file, 'no hard link');
    if (st.size > MAX_UPLOAD_BYTES)
      throw new FlowError(
        `upload: ${file} is ${st.size} bytes; uploads are at most ${MAX_UPLOAD_BYTES} bytes`,
      );
    const buffer = Buffer.alloc(st.size);
    let read = 0;
    while (read < st.size) {
      const n = readSync(fd, buffer, read, st.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return {
      name: basename(path),
      mimeType: MIME[extname(path).toLowerCase()] ?? 'application/octet-stream',
      buffer: buffer.subarray(0, read),
    };
  } finally {
    closeSync(fd);
  }
}
