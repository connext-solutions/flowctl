import { basename, dirname, join, relative, resolve } from 'node:path';
import type { LoadedConfig } from '../config.js';
import {
  assertNotSymlink,
  ConfigError,
  ensureDirInside,
  writeFileNoFollow,
} from '../foundation/index.js';
import type { AppMap } from './schema.js';

/**
 * The absolute path `file` (relative to the current directory) names for a copy of an `AppMap`, its directory
 * created: checked before a crawl starts, so a bad `--out` costs no crawl.
 *
 * @remarks The path must stay inside the flows root (ADR 0024 section 1a, the same containment as the runs
 *   directory: no `..`, no symlinked directory on the way), end in `.json`, not be under `.auth`, where the saved
 *   sessions live, and not be a symlink.
 * @throws {ConfigError} for a path outside the flows root, not ending in `.json`, under `.auth`, or a symlink.
 */
export function appMapPath(cfg: LoadedConfig, file: string): string {
  const target = resolve(file);
  if (!target.endsWith('.json'))
    throw new ConfigError(`--out must name a .json file, not ${file}`);
  const first = relative(cfg.flowsPath, target).split(/[\\/]/)[0];
  if (first?.toLowerCase() === '.auth')
    throw new ConfigError(
      `--out may not write under ${join(cfg.flowsPath, '.auth')}, where the saved sessions live`,
    );
  const path = join(
    ensureDirInside(dirname(target), cfg.flowsPath),
    basename(target),
  );
  assertNotSymlink(path);
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
