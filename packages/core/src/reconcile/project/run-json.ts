import { join } from 'node:path';
import { z } from 'zod';
import { type LoadedConfig, runsPath } from '../../config.js';
import { AssertionSchema } from '../../flow/index.js';
import {
  assertNotSymlink,
  ConfigError,
  type ErrorKind,
  NoFollowReadError,
  readFileNoFollow,
} from '../../foundation/index.js';
import type { RunResult } from '../../result.js';
import { RUN_ID_PATTERN } from '../../trust/index.js';

/** Every error kind, so the schema accepts exactly the kinds `RunResult` can hold; a new kind does not typecheck here until listed. */
const ERROR_KINDS: Record<ErrorKind, true> = {
  app_unreachable: true,
  profile_expired: true,
  setup_failed: true,
  flow_invalid: true,
  system1_unreachable: true,
  system1_not_allowed: true,
  hooks_untrusted: true,
  env_not_allowed: true,
  env_not_trusted: true,
  scope_violation: true,
  destructive_blocked: true,
  ledger_replay: true,
  ledger_mismatch: true,
  ledger_overflow: true,
  ledger_exists: true,
  budget_exceeded: true,
  internal: true,
};

/** The largest `run.json` read, in bytes; evidence lists are capped when written, so a real one is far smaller. */
export const MAX_RUN_JSON_BYTES = 16 * 1024 * 1024;

/**
 * The fields of `run.json` the classifier reads, checked; other fields (`heals`, `cleanup`, `system1`) are dropped.
 * A run's directory is local evidence, but it is a file anyone with the checkout can edit, so it is parsed, never
 * trusted. The env name is read beside the schema (`field('env')`), as `readRecordedRun` reads it: a schema key
 * named `env` is reserved for env inputs (`scripts/check-arch.mjs`).
 */
const RunJsonSchema = z.object({
  runId: z.string().regex(RUN_ID_PATTERN),
  flow: z.string(),
  status: z.enum(['passed', 'failed', 'error']),
  failed: z
    .union([
      z.object({
        step: z.number().int().min(0),
        kind: z.enum(['not_found', 'ambiguous', 'action_failed']),
        message: z.string(),
      }),
      z.object({ assertion: AssertionSchema, got: z.string() }),
    ])
    .optional(),
  error: z
    .object({
      kind: z.custom<ErrorKind>(
        (v) => typeof v === 'string' && Object.hasOwn(ERROR_KINDS, v),
      ),
      hint: z.string(),
    })
    .optional(),
  steps: z.number().int().min(0),
  healed: z.array(z.number().int()),
  teardownFailed: z.boolean(),
  weakLocators: z.array(z.string()),
  evidence: z.object({
    dir: z.string(),
    traces: z.array(z.string()),
    screenshot: z.string().optional(),
    network: z.array(z.string()),
    console: z.array(z.string()),
    trace: z.enum(['safe', 'full']).optional(),
    videos: z.array(z.string()).optional(),
  }),
  ms: z.number(),
});

const RunJson = z.record(z.string(), z.unknown());

/**
 * Reads the `run.json` of the run `runId` under the project's runs directory (`<flowsDir>/.runs/<run id>/`), with
 * no link followed on the way, and checks it is a flowctl run of that id.
 *
 * @returns the run directory and the result.
 * @throws {ConfigError} when `runId` is not a run id (`r_` and 1 to 32 lowercase letters or digits), the runs
 *   directory, the run directory or `run.json` is a symlink, missing or too large, or the file is not a flowctl run
 *   of that id. The message names a fixed reason (`not valid JSON`) or an error code (`ENOENT`), never the file's
 *   text: a `JSON.parse` message quotes the file's bytes, and the CLI prints a `ConfigError` as it is.
 */
export function readRunJson(
  cfg: LoadedConfig,
  runId: string,
): { dir: string; result: RunResult } {
  if (!RUN_ID_PATTERN.test(runId))
    throw new ConfigError(
      `${JSON.stringify(runId.slice(0, 40))} is not a run id: it is r_ and 1 to 32 lowercase letters or digits.`,
    );
  const runs = runsPath(cfg);
  const dir = join(runs, runId);
  const path = join(dir, 'run.json');
  assertNotSymlink(runs);
  assertNotSymlink(dir);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileNoFollow(path, MAX_RUN_JSON_BYTES));
  } catch (e) {
    const why = e instanceof NoFollowReadError ? e.message : 'not valid JSON';
    throw new ConfigError(
      `Cannot read ${path} (${why}); name a run of this project, as in ${runs}/<run id>.`,
    );
  }
  const parsed = RunJsonSchema.safeParse(raw);
  const run = RunJson.safeParse(raw);
  const field = (k: string): string | undefined => {
    const v = run.success ? run.data[k] : undefined;
    return typeof v === 'string' ? v : undefined;
  };
  const env = field('env');
  if (!parsed.success || parsed.data.runId !== runId || env === undefined)
    throw new ConfigError(`${path} is not a flowctl run of ${runId}.`);
  return { dir, result: { ...parsed.data, env } };
}
