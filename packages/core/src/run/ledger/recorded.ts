import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { ConfigError, type LoadedConfig, runsPath } from '../../config.js';
import { assertNotSymlink } from '../../safe-fs.js';
import { type RecordedCall, RUN_ID_PATTERN } from '../../trust/index.js';

/** A run's evidence as `trust add destructive --from-run` reads it. */
export interface RecordedRun {
  flow: string;
  env: string;
  status: string;
  calls: RecordedCall[];
}

const RunJson = z.record(z.string(), z.unknown());
const Network = z.array(
  z.object({
    method: z.string(),
    url: z.string(),
    status: z.number(),
    requestBody: z.unknown().optional(),
    note: z.string().optional(),
  }),
);

/**
 * Reads `run.json` and `network.json` of the run `runId` under the project's `.runs` (no link followed), for
 * deriving `destructiveConfirm` entries from a recorded run (ADR 0024 section 5, amendment 2026-11-13).
 *
 * @throws {ConfigError} when `runId` is not a run id, the run directory or a file is missing or a link, or a file
 *   does not have the evidence shape.
 */
export function readRecordedRun(cfg: LoadedConfig, runId: string): RecordedRun {
  if (!RUN_ID_PATTERN.test(runId))
    throw new ConfigError(
      `"${runId.slice(0, 40)}" is not a run id: it is r_ and 1 to 32 lowercase letters or digits.`,
    );
  const dir = join(runsPath(cfg), runId);
  const read = (name: string): unknown => {
    const path = join(dir, name);
    try {
      assertNotSymlink(dir);
      assertNotSymlink(path);
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new ConfigError(
        `Cannot read ${path} (${e instanceof Error ? e.message : String(e)}); --from-run names a run of this project, as in .flows/.runs/<run id>.`,
      );
    }
  };
  const run = RunJson.safeParse(read('run.json'));
  const net = Network.safeParse(read('network.json'));
  const field = (k: string): string | undefined => {
    const v = run.success ? run.data[k] : undefined;
    return typeof v === 'string' ? v : undefined;
  };
  const [flow, env, status] = [field('flow'), field('env'), field('status')];
  if (
    !net.success ||
    flow === undefined ||
    env === undefined ||
    status === undefined
  )
    throw new ConfigError(`The evidence in ${dir} is not a flowctl run's.`);
  return { flow, env, status, calls: net.data };
}
