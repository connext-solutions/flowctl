import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkRoot,
  componentProblem,
  type ContainedRoot,
  ContainmentError,
  MAX_DEPTH,
  splitRelative,
} from './root.js';

/**
 * A running total with a hard cap, for bytes or counts that arrive in pieces (a directory walk, a decompressing
 * stream): the cap is enforced as the bytes arrive, never from a size the source declares.
 *
 * @example
 *   const budget = new ByteBudget(64 * 1024 * 1024, 'decompressed bytes');
 *   for await (const chunk of stream) budget.take(chunk.length);
 */
export class ByteBudget {
  private used = 0;

  constructor(
    readonly limit: number,
    readonly what: string,
  ) {}

  /** Bytes (or items) taken so far. */
  get total(): number {
    return this.used;
  }

  /** @throws {ContainmentError} `too_large` when the total would pass the limit. */
  take(n: number): void {
    this.used += n;
    if (this.used > this.limit)
      throw new ContainmentError(
        'too_large',
        this.what,
        `more than ${this.limit} ${this.what}; the source is refused`,
      );
  }
}

/** Bounds of one directory walk. */
export interface WalkLimits {
  /** Directory entries read in total (files, directories and anything else). */
  maxEntries: number;
  /** Components of a returned path, counted from the root; never more than {@link MAX_DEPTH}. */
  maxDepth: number;
  /** Sum of the sizes of the files returned. */
  maxBytes: number;
  /** Size of one returned file; a larger file is skipped, not read. */
  maxFileBytes: number;
}

/** The default walk bounds: 10,000 entries, {@link MAX_DEPTH} levels, 64 MiB in total, 1 MiB per file. */
export const WALK_LIMITS: WalkLimits = {
  maxEntries: 10_000,
  maxDepth: MAX_DEPTH,
  maxBytes: 64 * 1024 * 1024,
  maxFileBytes: 1024 * 1024,
};

/** A regular file a walk found, by its `/`-separated path relative to the root. */
export interface WalkedFile {
  path: string;
  size: number;
}

/** An entry a walk left out, and the rule it failed; dot-prefixed names are left out silently. */
export interface SkippedEntry {
  path: string;
  rule: string;
}

/** What a walk lists besides its bounds: folder names it does not enter, files it leaves out unseen. */
export interface WalkOptions {
  prune?: ReadonlySet<string>;
  include?: (rel: string) => boolean;
}

/**
 * Lists the regular files below `root` (or below its subdirectory `sub`) with the rules {@link readContained}
 * applies: dot-prefixed names are not entered or listed; a link, a hard link, a FIFO, socket or device, a name
 * that fails {@link componentProblem} (`not_nfc` included) or a file over `maxFileBytes` is left out and reported
 * in `skipped`. Files come back in byte order of their path, so two walks of the same tree agree.
 *
 * @remarks A walk only names files; every read goes through {@link readContained}, which checks the chain again.
 *   Exceeding a bound refuses the whole walk rather than returning part of the tree.
 * @throws {ContainmentError} `too_large` for too many entries, a tree deeper than `maxDepth` or more than
 *   `maxBytes` in total (a directory at `maxDepth` components could only hold paths that a read refuses); `path_not_contained` for a `sub` that fails the lexical rules, is a link or is not a
 *   directory, or a root that changed; `not_found` for a missing `sub`.
 * @param opts `prune`: directory names that are not entered, at any depth, and are reported in `skipped` with
 *   rule `pruned` (a code reader leaves `node_modules` and build output out this way); a file with such a name is
 *   still listed. `include`: a predicate on the relative path of every entry that is not a directory or a link; an
 *   entry it refuses is neither listed, reported nor charged to `maxBytes` (a code reader leaves images and fonts
 *   out this way). Every directory entry still counts towards `maxEntries`, since it has to be read.
 */
export function walkContained(
  root: ContainedRoot,
  limits: Partial<WalkLimits> = {},
  sub?: string,
  opts: WalkOptions = {},
): { files: WalkedFile[]; skipped: SkippedEntry[] } {
  const lim = { ...WALK_LIMITS, ...limits };
  checkRoot(root);
  const start = sub === undefined ? [] : splitRelative(sub);
  assertDirChain(root, start, sub ?? '');
  const entries = new ByteBudget(lim.maxEntries, 'directory entries');
  const bytes = new ByteBudget(lim.maxBytes, 'bytes in the tree');
  const files: WalkedFile[] = [];
  const skipped: SkippedEntry[] = [];
  const pending: string[][] = [start];
  while (pending.length > 0) {
    const dir = pending.pop() ?? [];
    const names = listDir(join(root.path, ...dir), entries);
    const below: string[][] = [];
    for (const name of names) {
      if (name.startsWith('.')) continue;
      const parts = [...dir, name];
      const rel = parts.join('/');
      const problem = componentProblem(name);
      if (problem !== undefined) {
        skipped.push({ path: rel, rule: problem });
        continue;
      }
      let st;
      try {
        st = lstatSync(join(root.path, ...parts));
      } catch {
        skipped.push({ path: rel, rule: 'missing' });
        continue;
      }
      if (st.isSymbolicLink())
        skipped.push({ path: rel, rule: 'no symbolic link' });
      else if (st.isDirectory()) {
        if (opts.prune?.has(name) === true) {
          skipped.push({ path: rel, rule: 'pruned' });
          continue;
        }
        if (parts.length >= Math.min(lim.maxDepth, MAX_DEPTH))
          throw new ContainmentError(
            'too_large',
            'too deep',
            `${JSON.stringify(rel)} is too deep (paths have at most ${Math.min(lim.maxDepth, MAX_DEPTH)} components); the tree is refused`,
          );
        below.push(parts);
      } else if (opts.include !== undefined && !opts.include(rel)) continue;
      else if (!st.isFile())
        skipped.push({ path: rel, rule: 'must be a regular file' });
      else if (st.nlink !== 1)
        skipped.push({ path: rel, rule: 'no hard link' });
      else if (st.size > lim.maxFileBytes)
        skipped.push({ path: rel, rule: 'file size' });
      else {
        bytes.take(st.size);
        files.push({ path: rel, size: st.size });
      }
    }
    pending.push(...below.reverse());
  }
  checkRoot(root);
  files.sort((a, b) => cmp(a.path, b.path));
  skipped.sort((a, b) => cmp(a.path, b.path));
  return { files, skipped };
}

const cmp = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/** The names in `dir`, read one entry at a time so a huge directory stops at the entry budget. */
function listDir(dir: string, budget: ByteBudget): string[] {
  const handle = opendirSync(dir);
  const names: string[] = [];
  try {
    for (let d = handle.readSync(); d !== null; d = handle.readSync()) {
      budget.take(1);
      names.push(d.name);
    }
  } finally {
    handle.closeSync();
  }
  return names.sort(cmp);
}

/** Every component of `parts` below the root exists and is a real directory. */
function assertDirChain(
  root: ContainedRoot,
  parts: string[],
  rel: string,
): void {
  let at = root.path;
  for (const part of parts) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      throw new ContainmentError(
        'not_found',
        'missing',
        `${JSON.stringify(rel)} does not exist`,
      );
    }
    if (st.isSymbolicLink() || !st.isDirectory())
      throw new ContainmentError(
        'path_not_contained',
        'must be a directory',
        `${JSON.stringify(rel)} is refused (path_not_contained: must be a real directory)`,
      );
  }
}
