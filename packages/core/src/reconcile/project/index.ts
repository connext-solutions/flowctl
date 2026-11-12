/**
 * Reconcile on a project's own files (task T6.6): read a run's `run.json`, an `AppMap`, the code and spec folders
 * inside their roots, call the classifier or the gap finder, and write `classification.json` or the gaps files. The
 * entry points `flowctl reconcile` calls.
 *
 * @see docs/adr/0036-failure-classifier.md (amendment 2026-11-12)
 * @see docs/adr/0037-coverage-gaps.md (amendment 2026-11-12)
 */
export {
  latestAppMap,
  MAX_APPMAP_BYTES,
  projectRoot,
  readAppMapFile,
  specOperations,
} from './inputs.js';
export { classificationJson, gapsOutDir, writeClassification } from './out.js';
export {
  type GapsReconciled,
  reconcileGaps,
  reconcileRun,
  type ReconcileSources,
  type RunReconciled,
} from './reconcile.js';
export { MAX_RUN_JSON_BYTES, readRunJson } from './run-json.js';
