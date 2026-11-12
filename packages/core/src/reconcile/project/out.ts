import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type LoadedConfig, runsPath } from '../../config.js';
import { addRunArtefact } from '../../run/index.js';
import { hideInvisible } from '../../derive/index.js';
import {
  assertNotSymlink,
  ConfigError,
  ensureDirInside,
} from '../../foundation/index.js';
import { refuseReservedOut } from '../../observe/index.js';
import type { Classification } from '../classify/index.js';
import { CoverageGapsSchema } from '../gaps/index.js';

/** `c` as the text of `classification.json`: JSON with every invisible or control code point as a `\u` escape. */
export const classificationJson = (c: Classification): string =>
  `${hideInvisible(JSON.stringify(c, null, 2))}\n`;

/**
 * Writes `c` as `classification.json` into the directory of the run `c.runId` (`addRunArtefact`: inside the flows
 * directory, no symlinked component, the file itself never followed), every invisible or control code point as a
 * `\u` escape, and returns its path. The file is the classifier's advice next to the run's evidence, never a verdict.
 *
 * @throws {ConfigError} when the run directory is missing, leaves the flows directory or a component is a symlink.
 */
export const writeClassification = (
  cfg: LoadedConfig,
  c: Classification,
): string =>
  addRunArtefact(
    runsPath(cfg),
    cfg.flowsPath,
    c.runId,
    'classification.json',
    classificationJson(c),
  );

/** Whether `path` holds a coverage gaps report, so replacing it loses only an older report. */
function holdsGaps(path: string): boolean {
  try {
    return CoverageGapsSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
      .success;
  } catch {
    return false;
  }
}

/**
 * The directory `gaps.json` and `gaps.md` go to: `out` (relative to the current directory) or `<flowsDir>/gaps`,
 * with the containment of `observe --out`: inside the flows directory, not under `.auth`, `.git` or the runs
 * directory, created one component at a time with no symlink on the way. An existing `gaps.json` there must be a
 * gaps report, and an existing `gaps.md` is replaced only beside one, so a mistyped `--out` never overwrites a
 * project file.
 *
 * @throws {ConfigError} for a directory these rules refuse.
 */
export function gapsOutDir(cfg: LoadedConfig, out?: string): string {
  const target = resolve(out ?? join(cfg.flowsPath, 'gaps'));
  refuseReservedOut(cfg, target, out ?? target);
  const dir = ensureDirInside(target, cfg.flowsPath);
  const json = join(dir, 'gaps.json');
  const md = join(dir, 'gaps.md');
  assertNotSymlink(json);
  assertNotSymlink(md);
  if (
    (existsSync(json) && !holdsGaps(json)) ||
    (existsSync(md) && !existsSync(json))
  )
    throw new ConfigError(
      `--out ${out ?? target} holds a gaps.json or gaps.md that is not a gaps report; choose another directory`,
    );
  return dir;
}
