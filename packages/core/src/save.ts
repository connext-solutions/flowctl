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
import type { Assertion } from './flow/index.js';
import {
  FlowError,
  FlowSchema,
  claimsDerivation,
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

/** Who wrote a saved flow's expected values (`recorded.origin`): a person's request, or the generator (ADR 0020 section b). */
type SaveOrigin = 'human' | 'generator';

/**
 * Writes a passed exploration to `<flowsDir>/<name>.yaml`, but only after replaying it once
 * without any model and seeing it pass.
 *
 * @remarks The flow keeps the request's inputs and assertions as given (templates unexpanded) and
 *   the recorded steps (`by: system2` for orchestrator steps). An existing flow with the same name
 *   is replaced; the change shows up in `git diff`. The file records `recorded.origin: human` and carries no
 *   `derived` marker and no `sourceRef`: there is no argument to say otherwise, so provenance cannot be claimed
 *   through this door (ADR 0020 section b).
 * @throws {FlowError} when the exploration did not end `passed`, recorded no step, or `name` is not
 *   a valid flow name.
 * @see docs/adr/0008-strict-model-free-replay.md
 */
export function saveExploration(
  cfg: LoadedConfig,
  x: Exploration,
  o: SaveOptions,
): Promise<SaveResult> {
  return writeConfirmed(cfg, x, o, 'human', undefined);
}

/**
 * The generator's save (ADR 0020 section b): like {@link saveExploration}, but the expected values are the given
 * `assertions`, each carrying its `sourceRef`, and the file records `recorded.origin: generator` and `derived: true`.
 *
 * @remarks Not exported from `index.ts` and not reachable from `derive/` until T4.6 hands it over as a capability;
 *   `scripts/check-arch.mjs` keeps the name out of every other file. The flow replays labelled `unverified`: nothing
 *   proves a derivation yet. The exploration's own request cannot carry a `sourceRef` (the exploration edge refuses
 *   it), so the assertions come in explicitly.
 * @throws {FlowError} as {@link saveExploration}, and when `assertions` is empty or an assertion has no `sourceRef`.
 */
export function saveAsGenerator(
  cfg: LoadedConfig,
  x: Exploration,
  o: SaveOptions,
  assertions: Assertion[],
): Promise<SaveResult> {
  if (
    assertions.length === 0 ||
    assertions.some((a) => a.sourceRef === undefined)
  )
    return Promise.reject(
      new FlowError('A generated flow needs a sourceRef on every assertion'),
    );
  return writeConfirmed(cfg, x, o, 'generator', assertions);
}

async function writeConfirmed(
  cfg: LoadedConfig,
  x: Exploration,
  o: SaveOptions,
  origin: SaveOrigin,
  generated: Assertion[] | undefined,
): Promise<SaveResult> {
  if (!FlowSchema.shape.name.safeParse(o.name).success)
    throw new FlowError(
      `Invalid flow name "${o.name}": use lowercase letters, digits and dashes`,
    );
  const rec = x.recording();
  if (rec === undefined)
    throw new FlowError('Only an exploration that ended passed can be saved');
  const r = rec.request;
  const assertions = generated ?? r.assertions;
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
    assertions,
    ...(origin === 'generator' ? { derived: true } : {}),
    recorded: { at: dayjs().format('YYYY-MM-DD'), system1: rec.model, origin },
  };
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-save-'));
  try {
    const draft = join(dir, `${o.name}.yaml`);
    writeFileSync(draft, stringify(doc));
    const flow = loadFlow(draft, Object.keys(cfg.profiles));
    if (claimsDerivation(flow) !== (origin === 'generator'))
      throw new FlowError(
        `Flow "${o.name}" would be saved with the wrong provenance marker for origin ${origin}`,
      );
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
