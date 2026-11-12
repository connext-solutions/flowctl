import { existsSync, lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { RUN_ID_PATTERN } from '../trust/index.js';
import {
  assertNotSymlink,
  ConfigError,
  ensureDirInside,
  writeFileNoFollow,
} from '../foundation/index.js';

/**
 * The files a later command adds to a finished run's directory: `classification.json` (`flowctl reconcile`,
 * ADR 0036 amendment 2026-11-12). A closed list, like the one of `Evidence.artefact`.
 */
export type LateArtefact = 'classification.json';

/**
 * Writes `name` into the existing directory of the run `runId` under `runsDir`, and returns its path. The run
 * directory belongs to `Evidence` while the run lives; this is the only other writer, for a run that has finished.
 *
 * @remarks `runsDir` must be inside `flowsPath`; it and the run directory must exist (nothing is created) and not
 *   be symlinks, and the run directory must hold a regular `run.json` (a finished run's). The file is written
 *   through a temporary file and a rename, and a symlink at its path is refused first.
 * @throws {ConfigError} for a `runId` that is not a run id, a runs or run directory that does not exist, a run
 *   directory with no `run.json`, or a path these rules refuse.
 */
export function addRunArtefact(
  runsDir: string,
  flowsPath: string,
  runId: string,
  name: LateArtefact,
  text: string,
): string {
  if (!RUN_ID_PATTERN.test(runId))
    throw new ConfigError(
      `${JSON.stringify(runId.slice(0, 40))} is not a run id`,
    );
  const rel = relative(resolve(flowsPath), resolve(runsDir));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel))
    throw new ConfigError(`${runsDir} is not inside ${flowsPath}`);
  assertNotSymlink(runsDir);
  if (!existsSync(runsDir))
    throw new ConfigError(`the runs directory ${runsDir} does not exist`);
  const dir = join(runsDir, runId);
  assertNotSymlink(dir);
  if (!existsSync(dir))
    throw new ConfigError(`the run directory ${dir} does not exist`);
  const real = ensureDirInside(dir, runsDir);
  if (!isFile(join(real, 'run.json')))
    throw new ConfigError(
      `${dir} holds no run.json: it is not a finished run's directory`,
    );
  const path = join(real, name);
  assertNotSymlink(path);
  writeFileNoFollow(path, text);
  return path;
}

function isFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}
