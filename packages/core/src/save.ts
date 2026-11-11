import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dayjs from 'dayjs';
import type { Browser } from 'playwright';
import { stringify } from 'yaml';
import type { LoadedConfig } from './config.js';
import type { Exploration } from './explore/index.js';
import {
  FlowError,
  FlowSchema,
  loadFlow,
  serializeStep,
} from './flow/index.js';
import { replayFlow } from './replay.js';
import { writeFileNoFollow } from './safe-fs.js';
import type { RunResult } from './result.js';
import type { TrustStore } from './trust/index.js';

export interface SaveOptions {
  name: string;
  tags?: string[];
  browser: Browser;
  /** Trust store for hook consent in the confirming replay; tests inject one (ADR 0025 section 1). */
  store?: TrustStore;
}

export interface SaveResult {
  saved: boolean;
  file?: string;
  /** The confirming replay; when it did not pass, nothing was written. */
  replay: RunResult;
}

/**
 * Writes a passed exploration to `<flowsDir>/<name>.yaml`, but only after replaying it once
 * without any model and seeing it pass.
 *
 * @remarks The flow keeps the request's inputs and assertions as given (templates unexpanded) and
 *   the recorded steps (`by: system2` for orchestrator steps). An existing flow with the same name
 *   is replaced; the change shows up in `git diff`.
 * @throws {FlowError} when the exploration did not end `passed`, recorded no step, or `name` is not
 *   a valid flow name.
 * @see docs/adr/0008-strict-model-free-replay.md
 */
export async function saveExploration(
  cfg: LoadedConfig,
  x: Exploration,
  o: SaveOptions,
): Promise<SaveResult> {
  if (!FlowSchema.shape.name.safeParse(o.name).success)
    throw new FlowError(
      `Invalid flow name "${o.name}": use lowercase letters, digits and dashes`,
    );
  const rec = x.recording();
  if (rec === undefined)
    throw new FlowError('Only an exploration that ended passed can be saved');
  const r = rec.request;
  const doc = {
    name: o.name,
    goal: r.goal,
    tags: o.tags ?? [],
    profile: r.profile,
    ...(r.setup === undefined ? {} : { setup: r.setup }),
    ...(r.teardown === undefined ? {} : { teardown: r.teardown }),
    start: r.start,
    inputs: r.inputs ?? {},
    steps: rec.steps.map(serializeStep),
    assertions: r.assertions,
    recorded: { at: dayjs().format('YYYY-MM-DD'), system1: rec.model },
  };
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-save-'));
  try {
    const draft = join(dir, `${o.name}.yaml`);
    writeFileSync(draft, stringify(doc));
    const flow = loadFlow(draft, Object.keys(cfg.profiles));
    const replay = await replayFlow(cfg, flow, {
      env: rec.env,
      browser: o.browser,
      store: o.store,
    });
    if (replay.status !== 'passed') return { saved: false, replay };
    mkdirSync(cfg.flowsPath, { recursive: true });
    const file = join(cfg.flowsPath, `${o.name}.yaml`);
    writeFileNoFollow(file, readFileSync(draft, 'utf8'));
    return { saved: true, file, replay };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
