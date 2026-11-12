import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from 'node:path';
import { type LoadedConfig, runsPath } from '../../config.js';
import {
  ConfigError,
  NoFollowReadError,
  readFileNoFollow,
} from '../../foundation/index.js';
import { type AppMap, AppMapSchema } from '../../observe/index.js';
import {
  markdownSpecProvider,
  type Operation,
  SpecRegistry,
} from '../../spec/index.js';
import {
  type ContainedRoot,
  openRoot,
  RUN_ID_PATTERN,
} from '../../trust/index.js';

/** The largest `appmap.json` read, in bytes; a map holds at most 1,000 bounded pages. */
export const MAX_APPMAP_BYTES = 32 * 1024 * 1024;

/** Whether the real path `inner` is `outer` or below it. */
const within = (inner: string, outer: string): boolean => {
  const rel = relative(outer, inner);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * Opens `dir` as a root of `purpose` (`repos` for `--code`, `specs` for `--spec`) when its real path is the project
 * root or below it, and not in a dot folder of it.
 *
 * @remarks The trust store's `roots` can hold `repos` and `specs` entries (ADR 0025 section 2), but no command
 *   registers one yet (`trust add root` is reserved), so the project root, which the store does register, is the
 *   containing root: a directory outside it is refused, never read (ADR 0036, amendment 2026-11-12). Dot folders
 *   (`.git`, `.flows`, `.flows/.runs`, `.flows/.auth`) are never entered by the readers below a root, and a root
 *   inside one is refused for the same reason: it would read sessions, run evidence or git metadata.
 * @throws {ContainmentError} when `dir` is missing or not a directory.
 * @throws {ConfigError} when its real path is outside the project root or has a dot-prefixed component below it.
 */
export function projectRoot(
  cfg: LoadedConfig,
  dir: string,
  purpose: 'repos' | 'specs',
): ContainedRoot {
  const flag = purpose === 'repos' ? '--code' : '--spec';
  const root = openRoot(resolve(dir), purpose);
  const project = realpathSync(cfg.root);
  if (!within(root.path, project))
    throw new ConfigError(
      `${flag} ${dir} is not inside the project root ${cfg.root}; registering another root in the trust store is not available yet.`,
    );
  if (
    relative(project, root.path)
      .split(/[\\/]/)
      .some((p) => p.startsWith('.'))
  )
    throw new ConfigError(
      `${flag} ${dir} is in a dot folder of the project root (such as .git, .flows, .runs or .auth); name a folder outside them.`,
    );
  return root;
}

/**
 * Reads and checks an `AppMap` file inside the flows directory (a run's `appmap.json`, or an `observe --out` copy):
 * a regular `.json` file, no link at the end and none on the way out of the flows directory, never under `.auth`.
 * The file is opened `O_NOFOLLOW` and checked and read from the descriptor.
 *
 * @param label how errors name the file: `--appmap <file>` by default.
 * @throws {ConfigError} for a path these rules refuse, a file that cannot be read, or one that is not an `AppMap`;
 *   the message names a fixed reason or an error code, never the file's text.
 */
export function readAppMapFile(
  cfg: LoadedConfig,
  file: string,
  label = `--appmap ${file}`,
): AppMap {
  const target = resolve(file);
  let real: string;
  try {
    real = join(realpathSync(dirname(target)), basename(target));
  } catch {
    throw new ConfigError(`${label} does not exist`);
  }
  let flows: string;
  try {
    flows = realpathSync(cfg.flowsPath);
  } catch {
    throw new ConfigError(
      `the flows directory ${cfg.flowsPath} does not exist; ${label} must be inside it`,
    );
  }
  const parts = relative(flows, real).toLowerCase().split(/[\\/]/);
  if (!within(real, flows) || parts.includes('.auth'))
    throw new ConfigError(
      `${label} is not inside the flows directory ${cfg.flowsPath} (no symlink, not under .auth)`,
    );
  if (!real.endsWith('.json'))
    throw new ConfigError(`${label} must be a .json file of at most 32 MiB`);
  let text: string;
  try {
    text = readFileNoFollow(real, MAX_APPMAP_BYTES);
  } catch (e) {
    const why = e instanceof NoFollowReadError ? e.message : 'unreadable';
    throw new ConfigError(
      why === 'ENOENT'
        ? `${label} does not exist`
        : `${label} cannot be read (${why}): it must be a regular .json file of at most 32 MiB, no symlink`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = undefined;
  }
  const parsed = AppMapSchema.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`${label} is not an AppMap`);
  return parsed.data;
}

/**
 * The `appmap.json` of the latest crawl under the runs directory, or `undefined` when no run has one.
 *
 * @remarks A run id starts with its creation time in base 36 (`r_<ms><4 hex>`), so the run whose id sorts last (by
 *   length, then code units) is the latest; no file is read and no modification time is used, so the choice depends
 *   only on the directory names. Only real directories named like a run id with a regular `appmap.json` count.
 */
export function latestAppMap(cfg: LoadedConfig): string | undefined {
  const runs = runsPath(cfg);
  let names: string[];
  try {
    if (!lstatSync(runs).isDirectory()) return undefined;
    names = readdirSync(runs);
  } catch {
    return undefined;
  }
  const isFile = (path: string, dir: boolean): boolean => {
    try {
      const st = lstatSync(path);
      return dir ? st.isDirectory() : st.isFile();
    } catch {
      return false;
    }
  };
  const ids = names
    .filter((n) => RUN_ID_PATTERN.test(n))
    .filter(
      (n) =>
        isFile(join(runs, n), true) &&
        isFile(join(runs, n, 'appmap.json'), false),
    )
    .sort((a, b) => b.length - a.length || (a < b ? 1 : a > b ? -1 : 0));
  const id = ids[0];
  return id === undefined ? undefined : join(runs, id, 'appmap.json');
}

/**
 * The operations of the markdown spec folder `root`, validated, with how many documents were left out.
 *
 * @throws {ConfigError} as the markdown provider and `SpecRegistry.operations` do.
 */
export async function specOperations(
  root: ContainedRoot,
): Promise<{ operations: Operation[]; skipped: number }> {
  let skipped = 0;
  const registry = new SpecRegistry();
  registry.register(
    markdownSpecProvider(root, {
      onSkip: () => {
        skipped += 1;
      },
    }),
  );
  const operations = await registry.operations('markdown');
  return { operations, skipped };
}
