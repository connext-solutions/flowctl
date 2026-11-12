import { realpathSync } from 'node:fs';
import type { LoadedConfig } from '../../config.js';
import { ConfigError } from '../../foundation/index.js';
import type { AppMap } from '../../observe/index.js';
import type { RunStatus } from '../../result.js';
import type { Operation } from '../../spec/index.js';
import { type Classification, classifyFailure } from '../classify/index.js';
import { buildCodeIndex } from '../code/index.js';
import type { ContainedRoot } from '../../trust/index.js';
import {
  type CoverageGaps,
  coverageGaps,
  CoverageGapsSchema,
  gapsJson,
  writeGaps,
} from '../gaps/index.js';
import {
  latestAppMap,
  projectRoot,
  readAppMapFile,
  specOperations,
} from './inputs.js';
import { classificationJson, gapsOutDir, writeClassification } from './out.js';
import { readRunJson } from './run-json.js';

/** What a reconcile reads besides the run: paths as the caller names them (relative to the current directory). */
export interface ReconcileSources {
  /** The app's source, for the code index: a directory inside the project root (a root of purpose `repos`). */
  code?: string;
  /** An `AppMap` file inside the flows directory. */
  appmap?: string;
  /** A folder of markdown spec documents inside the project root (a root of purpose `specs`). */
  spec?: string;
}

/** What `reconcileRun` did: the classification, where it was written, and the run and operation it used. */
export interface RunReconciled {
  classification: Classification;
  /** The `classification.json` written into the run directory. */
  file: string;
  flow: string;
  status: RunStatus;
  /** The id of the spec operation the classifier read, or `null` when none was linked (see the notes). */
  operation: string | null;
  /** The text written to `file`: the classification as JSON, invisible and control code points escaped. */
  text: string;
}

/** What `reconcileGaps` did: the gaps, the files written, the map read and notes about the inputs. */
export interface GapsReconciled {
  gaps: CoverageGaps;
  files: { json: string; markdown: string };
  /** The `AppMap` file read: `--appmap`, or the latest run's `appmap.json`. */
  appmap: string;
  notes: string[];
  /** The text written to `gaps.json`, invisible and control code points escaped. */
  text: string;
}

const skippedNote = (n: number): string[] =>
  n === 0
    ? []
    : [
        `${n} spec ${n === 1 ? 'document was' : 'documents were'} skipped (not a valid operation)`,
      ];

/** The roots of `--code` and `--spec`, opened and checked first, before anything is read or a directory is made. */
const roots = (
  cfg: LoadedConfig,
  src: ReconcileSources,
): { code?: ContainedRoot; spec?: ContainedRoot } => ({
  code:
    src.code === undefined ? undefined : projectRoot(cfg, src.code, 'repos'),
  spec:
    src.spec === undefined ? undefined : projectRoot(cfg, src.spec, 'specs'),
});

/** The operations of the `--spec` root, or `undefined` without one. */
async function operations(
  root?: ContainedRoot,
): Promise<{ operations: Operation[]; skipped: number } | undefined> {
  return root === undefined ? undefined : specOperations(root);
}

/** The origin of the env's `baseUrl` in the config, or `undefined` when the config no longer has that env. */
function envOrigin(cfg: LoadedConfig, env: string): string | undefined {
  const e = Object.hasOwn(cfg.envs, env) ? cfg.envs[env] : undefined;
  return e === undefined ? undefined : new URL(e.baseUrl).origin;
}

/**
 * Classifies the failed or errored run `runId` of this project (ADR 0036) and writes the answer as
 * `classification.json` into its run directory.
 *
 * @remarks Reads the run's `run.json`; with `code`, a code index of that directory; with `appmap`, that map; with
 *   `spec`, the markdown operation whose `id` equals the run's flow name, exactly, and only when one operation does
 *   (no or several give no spec and a note: a run records no link to a spec, so nothing else is guessed). The app's
 *   origins are the run env's `baseUrl` origin from the config and the map's origin. A map is never picked by
 *   default here: one from another env would change which origins count as the app's. Advice, never a verdict.
 * @throws {ConfigError} for a bad run id or run directory, a source these rules refuse (outside its root, not a map)
 *   or a source the code index or the spec provider refuses (`ContainmentError`).
 * @see docs/adr/0036-failure-classifier.md (amendment 2026-11-12)
 */
export async function reconcileRun(
  cfg: LoadedConfig,
  runId: string,
  src: ReconcileSources = {},
): Promise<RunReconciled> {
  const { result } = readRunJson(cfg, runId);
  const open = roots(cfg, src);
  const map: AppMap | undefined =
    src.appmap === undefined ? undefined : readAppMapFile(cfg, src.appmap);
  const code = open.code === undefined ? undefined : buildCodeIndex(open.code);
  const spec = await operations(open.spec);
  const linked = spec?.operations.filter((o) => o.id === result.flow) ?? [];
  const op = linked.length === 1 ? linked[0] : undefined;
  const origins = [envOrigin(cfg, result.env), map?.origin].filter(
    (o): o is string => o !== undefined,
  );
  const c = classifyFailure({
    result,
    code,
    map,
    spec: op,
    origins: origins.length === 0 ? undefined : [...new Set(origins)],
  });
  const notes = [...c.notes, ...skippedNote(spec?.skipped ?? 0)];
  if (spec !== undefined && op === undefined)
    notes.push(
      linked.length === 0
        ? 'no spec operation has the flow name as its id: spec rules not run'
        : `${linked.length} spec operations have the flow name as their id: spec rules not run`,
    );
  const classification = { ...c, notes };
  return {
    classification,
    file: writeClassification(cfg, classification),
    flow: result.flow,
    status: result.status,
    operation: op?.id ?? null,
    text: classificationJson(classification),
  };
}

/**
 * Computes the coverage gaps between the code (`code`), one crawl (`appmap`, by default the latest run's
 * `appmap.json`) and the spec (`spec`) (ADR 0037), and writes `gaps.json` and `gaps.md` into `out` (default
 * `<flowsDir>/gaps`), contained like `observe --out`.
 *
 * @throws {ConfigError} when no map is named and no run has one, for an `out` or a source these rules refuse, or a
 *   source the code index or the spec provider refuses.
 * @see docs/adr/0037-coverage-gaps.md (amendment 2026-11-12)
 */
export async function reconcileGaps(
  cfg: LoadedConfig,
  src: ReconcileSources & { out?: string } = {},
): Promise<GapsReconciled> {
  const appmap = src.appmap ?? latestAppMap(cfg);
  if (appmap === undefined)
    throw new ConfigError(
      'reconcile --gaps needs an app map: run flowctl observe first, or name one with --appmap <file>',
    );
  const open = roots(cfg, src);
  const map = readAppMapFile(
    cfg,
    appmap,
    src.appmap === undefined ? "the latest run's appmap.json" : undefined,
  );
  const dir = gapsOutDir(cfg, src.out);
  const index = open.code === undefined ? undefined : buildCodeIndex(open.code);
  const spec = await operations(open.spec);
  const gaps = coverageGaps({ index, map, operations: spec?.operations });
  return {
    gaps,
    files: writeGaps(dir, realpathSync(cfg.flowsPath), gaps),
    appmap,
    notes: skippedNote(spec?.skipped ?? 0),
    text: gapsJson(CoverageGapsSchema.parse(gaps)),
  };
}
