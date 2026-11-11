import {
  type ContainedRoot,
  ContainmentError,
  readContained,
  walkContained,
} from '../../trust/index.js';
import { decodeSource } from './text.js';
import type { CodeIndexLimits, IndexSkip } from './types.js';

/** What to walk: folders below the root (`undefined`: the whole root), folder names never entered, files to list. */
export interface WalkPlan {
  dirs: readonly string[] | undefined;
  prune: ReadonlySet<string>;
  include: (rel: string) => boolean;
}

/**
 * Every file of the walks over `plan.dirs`, by path, with the walks' skipped entries; overlapping folders count once.
 * Each `dirs` entry is its own walk with its own `maxEntries` budget.
 *
 * @throws {ContainmentError} as `walkContained` does.
 */
export function walkAll(
  root: ContainedRoot,
  plan: WalkPlan,
  lim: CodeIndexLimits,
): { files: Map<string, number>; skipped: IndexSkip[] } {
  const files = new Map<string, number>();
  const skipped = new Map<string, IndexSkip>();
  const subs: (string | undefined)[] =
    plan.dirs === undefined ? [undefined] : [...plan.dirs];
  for (const sub of subs) {
    const walked = walkContained(
      root,
      {
        maxEntries: lim.maxEntries,
        maxBytes: lim.maxBytes,
        maxFileBytes: lim.maxFileBytes,
      },
      sub,
      { prune: plan.prune, include: plan.include },
    );
    for (const f of walked.files) files.set(f.path, f.size);
    for (const s of walked.skipped) skipped.set(`${s.path}\0${s.rule}`, s);
  }
  return { files, skipped: [...skipped.values()] };
}

const isSystemError = (e: unknown): boolean =>
  e instanceof Error && 'code' in e && typeof e.code === 'string';

/**
 * The bytes of `path` decoded, or the rule that left it out, with the number of bytes actually read. A refused read
 * keeps the containment rule; a file system error such as `EACCES` is `unreadable`.
 *
 * @throws {ContainmentError} `path_not_contained` with rule `root changed`: the root was swapped during the build,
 *   so nothing read from it can be trusted and the build is refused.
 */
export function readText(
  root: ContainedRoot,
  path: string,
  maxBytes: number,
): ({ text: string } | { rule: string }) & { bytes: number } {
  let bytes: Buffer;
  try {
    bytes = readContained(root, path, { maxBytes });
  } catch (e) {
    if (e instanceof ContainmentError && e.rule !== 'root changed')
      return { rule: e.rule, bytes: 0 };
    if (!(e instanceof ContainmentError) && isSystemError(e))
      return { rule: 'unreadable', bytes: 0 };
    throw e;
  }
  const decoded = decodeSource(bytes);
  return decoded.ok
    ? { text: decoded.text, bytes: bytes.length }
    : { rule: decoded.rule, bytes: bytes.length };
}
