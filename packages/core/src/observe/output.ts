import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { runsPath, type LoadedConfig } from '../config.js';
import {
  assertNotSymlink,
  ConfigError,
  ensureDirInside,
  writeFileNoFollow,
} from '../foundation/index.js';
import { AppMapSchema, type AppMap } from './schema.js';

/** Directories under the flows root an `AppMap` copy never goes to: sessions, run evidence, git metadata. */
const FORBIDDEN = new Set(['.auth', '.git']);

/** Whether `path` holds an `AppMap` already, so replacing it loses nothing but an older map. */
function holdsMap(path: string): boolean {
  try {
    return AppMapSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      .success;
  } catch {
    return false;
  }
}

/**
 * Refuses an output path under `.auth` (the saved sessions), a `.git` directory or the runs directory (other runs'
 * evidence) of the flows root, by its components below that root, in any case. Containment itself is the caller's
 * (`ensureDirInside`).
 *
 * @param target the absolute path an `--out` option names.
 * @param given the path as the user wrote it, for the message.
 * @throws {ConfigError} for a path under one of those directories.
 */
export function refuseReservedOut(
  cfg: LoadedConfig,
  target: string,
  given: string,
): void {
  const parts = relative(cfg.flowsPath, target)
    .split(/[\\/]/)
    .map((p) => p.toLowerCase());
  const runs = relative(cfg.flowsPath, runsPath(cfg)).toLowerCase();
  if (parts.some((p) => FORBIDDEN.has(p)) || parts[0] === runs)
    throw new ConfigError(
      `--out may not write under .auth, .git or ${runs} (sessions, git metadata and run evidence): ${given}`,
    );
}

/**
 * The absolute path `file` (relative to the current directory) names for a copy of an `AppMap`, its directory
 * created: checked before a crawl starts, so a bad `--out` costs no crawl.
 *
 * @remarks The path must stay inside the flows root (ADR 0024 section 1a, the same containment as the runs
 *   directory: no `..`, no symlinked directory on the way), end in `.json`, not be a symlink, and not be under
 *   `.auth` (the saved sessions), a `.git` directory or the runs directory (other runs' evidence). An existing file
 *   there is replaced only when it is an `AppMap` itself, so a mistyped path never overwrites a project file when
 *   `flowsDir` is the project root.
 * @throws {ConfigError} for any path these rules refuse.
 */
export function appMapPath(cfg: LoadedConfig, file: string): string {
  const target = resolve(file);
  if (!target.endsWith('.json'))
    throw new ConfigError(`--out must name a .json file, not ${file}`);
  refuseReservedOut(cfg, target, file);
  const path = join(
    ensureDirInside(dirname(target), cfg.flowsPath),
    basename(target),
  );
  assertNotSymlink(path);
  if (existsSync(path) && !holdsMap(path))
    throw new ConfigError(
      `--out ${file} exists and is not an AppMap; choose a new file name`,
    );
  return path;
}

/**
 * Writes `map` as JSON to the {@link appMapPath} of `file` and returns that path: a copy of the run's `appmap.json`
 * where a person or a later stage wants it. Written through a temporary file and a rename.
 *
 * @throws {ConfigError} as {@link appMapPath}.
 */
export function writeAppMap(
  cfg: LoadedConfig,
  map: AppMap,
  file: string,
): string {
  const path = appMapPath(cfg, file);
  writeFileNoFollow(path, `${JSON.stringify(map, null, 2)}\n`);
  return path;
}
