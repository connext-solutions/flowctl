import { lstatSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ConfigError } from '../../foundation/index.js';

/** The purposes a store `roots` entry is registered for (ADR 0025 section 2, `roots`). */
export type RootPurpose = 'flows' | 'contracts' | 'specs' | 'repos' | 'issues';

/**
 * Why a read under a root was refused: `path_not_contained` (a containment rule, ADR 0024 section 1a rule 13),
 * `not_found` (nothing at the path), `too_large` (a size, count or depth cap).
 */
export type ContainmentErrorKind =
  | 'path_not_contained'
  | 'not_found'
  | 'too_large';

/**
 * A refused read under a contained root. It is a {@link ConfigError}, so callers that already handle bad
 * configuration handle it too; `rule` names the rule that failed. The message names the path and the rule,
 * never the file's content.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export class ContainmentError extends ConfigError {
  constructor(
    readonly kind: ContainmentErrorKind,
    readonly rule: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A directory flowctl may read below, with the purpose it was registered for and the device and inode it had when
 * it was opened (so a root swapped afterwards is refused).
 *
 * @remarks Today the caller names the path ({@link openRoot}); the trust-store reader will build the same object
 *   from a verified `roots` entry, so readers keep taking a `ContainedRoot` and never a bare path.
 */
export interface ContainedRoot {
  readonly path: string;
  readonly purpose: RootPurpose;
  readonly dev: number;
  readonly ino: number;
}

/** Most components in a relative path, and most directory levels a walk descends. */
export const MAX_DEPTH = 16;
const MAX_COMPONENT_BYTES = 255;
const MAX_PATH_CHARS = 4096;

/** A `path_not_contained` refusal of `rel` under `rule`. */
export const containmentRefusal = (
  rel: string,
  rule: string,
): ContainmentError =>
  new ContainmentError(
    'path_not_contained',
    rule,
    `${JSON.stringify(rel)} is refused (path_not_contained: ${rule}); name a file by a plain relative path inside the root, with no link in it`,
  );

/**
 * Opens `path` as a root of `purpose`: an absolute directory, resolved once with `realpath`.
 *
 * @throws {ContainmentError} `path_not_contained` for a relative path or one that is not a directory;
 *   `not_found` when it does not exist.
 */
export function openRoot(path: string, purpose: RootPurpose): ContainedRoot {
  if (!isAbsolute(path) || path.includes('\0'))
    throw containmentRefusal(path, 'root must be an absolute path');
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    throw new ContainmentError(
      'not_found',
      'root missing',
      `root ${path} does not exist`,
    );
  }
  const st = lstatSync(real);
  if (!st.isDirectory())
    throw containmentRefusal(path, 'root must be a directory');
  return Object.freeze({ path: real, purpose, dev: st.dev, ino: st.ino });
}

/**
 * Refuses a root registered for another purpose: a provider reads only from roots of its own purpose (ADR 0023
 * rule 3, ADR 0025 section 2).
 *
 * @throws {ContainmentError} `path_not_contained` with rule `purpose`.
 */
export function requirePurpose(
  root: ContainedRoot,
  purpose: RootPurpose,
): void {
  if (root.purpose !== purpose)
    throw new ContainmentError(
      'path_not_contained',
      'purpose',
      `the root ${root.path} is registered for ${root.purpose}, not ${purpose}`,
    );
}

/**
 * Refuses a root whose directory is no longer the one opened (replaced, or turned into a link).
 *
 * @throws {ContainmentError} `path_not_contained` with rule `root changed`.
 */
export function checkRoot(root: ContainedRoot): void {
  let ok = false;
  try {
    const st = lstatSync(root.path);
    ok = st.isDirectory() && st.dev === root.dev && st.ino === root.ino;
  } catch {
    ok = false;
  }
  if (!ok) throw containmentRefusal(root.path, 'root changed');
}

/**
 * The problem with one path component, or `undefined` when it is acceptable: empty, `.`/`..`, a dot-prefixed
 * name (no dotfile, `.git`, `.auth` or `.runs` in any case), a Windows form (`:` inside, a trailing dot or space),
 * a control character, not NFC, or longer than 255 bytes (ADR 0024 section 1a rules 1, 5 and 6; ADR 0023
 * Amendment 2026-11-02, `location`).
 */
export function componentProblem(part: string): string | undefined {
  if (part === '') return 'empty component';
  if (part === '.' || part === '..') return 'no . or .. component';
  if (part.startsWith('.')) return 'no dot-prefixed component';
  if (part.includes(':') || /[. ]$/.test(part)) return 'no Windows form';
  if (/\p{Cc}/u.test(part)) return 'no control character';
  if (part.normalize('NFC') !== part) return 'not_nfc';
  if (Buffer.byteLength(part) > MAX_COMPONENT_BYTES)
    return 'component too long';
  return undefined;
}

/**
 * Splits a relative path into components after the lexical checks, before any file-system call: no NUL, no
 * backslash, not absolute, no leading `~`, no drive letter, at most {@link MAX_DEPTH} components, and every
 * component passing {@link componentProblem}.
 *
 * @throws {ContainmentError} `path_not_contained` with the rule that failed.
 */
export function splitRelative(rel: string): string[] {
  if (rel === '' || rel.length > MAX_PATH_CHARS)
    throw containmentRefusal(rel, 'empty or too long');
  if (rel.includes('\0') || rel.includes('\\'))
    throw containmentRefusal(rel, 'no NUL or backslash');
  if (rel.startsWith('/') || rel.startsWith('~') || /^[A-Za-z]:/.test(rel))
    throw containmentRefusal(rel, 'must be relative');
  const parts = rel.split('/');
  if (parts.length > MAX_DEPTH) throw containmentRefusal(rel, 'too deep');
  for (const part of parts) {
    const problem = componentProblem(part);
    if (problem !== undefined) throw containmentRefusal(rel, problem);
  }
  return parts;
}
