import { createHash } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';
import { join } from 'node:path';
import { bytesAllowed } from './lexer.js';
import type { ClosureFile, UncoveredReason } from './types.js';

/** ADR 0021 Amendment 2026-11-01 section 2.6 and Amendment 2026-11-02 section 7. */
export const LIMITS = {
  fileBytes: 256 * 1024,
  totalBytes: 1024 * 1024,
  files: 50,
} as const;

/** A file the closure read: its identity (device and inode), path, bytes and kind. */
export interface ReadFile {
  id: string;
  path: string;
  bytes: Buffer;
  kind: 'script' | 'data';
}

/** What `lstat` finds at a path under the flows root, never following a symlink. */
export type Node =
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'dir' }
  | { kind: 'file'; st: BigIntStats }
  | { kind: 'other' };

/**
 * `lstat`s each component of `norm` under `root` in turn: the first symlink, missing component or
 * non-directory parent decides the result, so nothing is followed.
 */
export function lookup(root: string, norm: string): Node {
  if (norm === '') return { kind: 'dir' };
  const parts = norm.split('/');
  let path = root;
  for (const [k, part] of parts.entries()) {
    path = join(path, part);
    let st: BigIntStats;
    try {
      st = lstatSync(path, { bigint: true });
    } catch {
      return { kind: 'missing' };
    }
    if (st.isSymbolicLink()) return { kind: 'symlink' };
    if (k < parts.length - 1) {
      if (!st.isDirectory()) return { kind: 'missing' };
      continue;
    }
    if (st.isDirectory()) return { kind: 'dir' };
    return st.isFile() ? { kind: 'file', st } : { kind: 'other' };
  }
  return { kind: 'missing' };
}

/**
 * A shell script in the sense of ADR 0021 Amendment 2026-11-01 section 2.2 c: no BOM, and a first line
 * that is exactly `#!/bin/sh` or `#!/bin/dash`, or no `#!` line at all.
 */
export function shellScript(bytes: Buffer): 'sh' | 'dash' | undefined {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return undefined;
  if (bytes[0] !== 0x23 || bytes[1] !== 0x21) return 'sh';
  const nl = bytes.indexOf(0x0a);
  const first = bytes.subarray(0, nl === -1 ? bytes.length : nl).toString();
  if (first === '#!/bin/sh') return 'sh';
  return first === '#!/bin/dash' ? 'dash' : undefined;
}

/**
 * Every file one closure reads, each hashed once and counted once (by device and inode, as bigints so no
 * two 64-bit inodes collide), within the limits of 50 files, 256 KiB each and 1 MiB in total.
 */
export class FileTable {
  private readonly byId = new Map<string, ReadFile>();
  private total = 0;
  /** False once a file cannot be shown at consent (refused bytes or over 256 KiB). */
  showable = true;

  constructor(readonly root: string) {}

  /**
   * Reads the regular file `norm` found by {@link lookup}: opened `O_NOFOLLOW|O_NONBLOCK`, `fstat`ed and
   * matched to the `lstat` by device and inode before its bytes are read.
   *
   * @returns the file, or the reason it cannot be part of the closure.
   */
  read(norm: string, st: BigIntStats): ReadFile | UncoveredReason {
    if (st.nlink > 1n) return 'hardlink';
    const id = `${st.dev}:${st.ino}`;
    const known = this.byId.get(id);
    if (known !== undefined) return known;
    if (this.byId.size >= LIMITS.files) return 'limit_exceeded';
    if (st.size > BigInt(LIMITS.fileBytes)) {
      this.showable = false;
      return 'limit_exceeded';
    }
    const bytes = readExact(join(this.root, norm), st);
    if (typeof bytes === 'string') return bytes;
    this.total += bytes.length;
    if (this.total > LIMITS.totalBytes) return 'limit_exceeded';
    if (!bytesAllowed(bytes)) this.showable = false;
    const file: ReadFile = {
      id,
      path: norm,
      bytes,
      kind: shellScript(bytes) === undefined ? 'data' : 'script',
    };
    this.byId.set(id, file);
    return file;
  }

  /** The closure's `files`, sorted bytewise by path (ADR 0021 Amendment 2026-11-01 section 2.8). */
  list(): ClosureFile[] {
    return [...this.byId.values()]
      .map((f) => ({
        path: f.path,
        sha256: createHash('sha256').update(f.bytes).digest('hex'),
        kind: f.kind,
      }))
      .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  }
}

function readExact(
  path: string,
  expected: BigIntStats,
): Buffer | UncoveredReason {
  let fd: number;
  try {
    fd = openSync(
      path,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'ELOOP'
      ? 'symlink'
      : 'missing_file';
  }
  try {
    const st = fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.dev !== expected.dev || st.ino !== expected.ino)
      return 'symlink';
    if (st.nlink > 1n) return 'hardlink';
    if (st.size > BigInt(LIMITS.fileBytes)) return 'limit_exceeded';
    const buf = Buffer.alloc(Number(st.size));
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    closeSync(fd);
  }
}

/**
 * Reads the closure file `norm` under `root` the way the closure did (every component `lstat`ed, the file
 * opened `O_NOFOLLOW` and matched by device and inode) and returns its bytes only if their sha256 is
 * `sha256`, so a snapshot holds exactly the bytes the digest covers (ADR 0021 Amendment 2026-11-01 s.2.7).
 *
 * @returns the bytes, or `undefined` when the file changed, moved, became a link or cannot be read.
 */
export function readVerifiedFile(
  root: string,
  norm: string,
  sha256: string,
): Buffer | undefined {
  const node = lookup(root, norm);
  if (node.kind !== 'file' || node.st.nlink > 1n) return undefined;
  const bytes = readExact(join(root, norm), node.st);
  if (typeof bytes === 'string') return undefined;
  const got = createHash('sha256').update(bytes).digest('hex');
  return got === sha256 ? bytes : undefined;
}
