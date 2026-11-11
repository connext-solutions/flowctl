import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
