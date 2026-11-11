/**
 * The layer model of `packages/core/src`, shared by the static gate (`check-arch.mjs`) and the runtime
 * load check (`check-bundle-plugins.mjs`) so the two can never disagree about what a layer is.
 */

/**
 * Layers inside core, lowest first; a folder or top-level file may import only layers listed before its
 * own. Folders are named by their directory, top-level files by their base name (`config`, `flow`).
 * The labels are the TRUE layers today (`result.ts` imports `flow`, `safe-fs.ts` imports `config`); task
 * T1.0 moves the shared pieces into `foundation` and reorders this list. The roadmap folders (`trust`,
 * `login`, `spec`, `observe`, `provenance`, `derive`, `reconcile`, `report`) are listed ahead of their code so a
 * wrong-way import fails the day the folder appears: derive may use observe and spec, never the reverse.
 */
export const CORE_LAYERS = [
  'foundation',
  'trust',
  'config',
  'safe-fs',
  'flow',
  'result',
  'browser',
  'run',
  'login',
  'system1',
  'explore',
  'spec',
  'observe',
  'provenance',
  'derive',
  'reconcile',
  'report',
];

/** Top-level core files that sit above every folder and may import anything. */
export const CORE_ENTRIES = ['replay', 'save', 'login', 'index'];

export const stripExt = (name) => name.replace(/\.[cm]?[jt]sx?$/i, '');
/** Index of a layer name, case-folded; -1 when it is not listed. */
export const layerOf = (name) => CORE_LAYERS.indexOf(name.toLowerCase());
/** Layer name of a path below `src/` (or `dist/`), given as segments: the folder, or the file's base name. */
export const layerName = (parts) => (parts.length === 1 ? stripExt(parts[0] ?? '') : (parts[0] ?? ''));
export const isEntry = (parts) => parts.length === 1 && CORE_ENTRIES.includes(stripExt(parts[0] ?? '').toLowerCase());
