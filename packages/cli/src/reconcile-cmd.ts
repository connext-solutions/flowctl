import {
  type ClassEvidence,
  ConfigError,
  GAP_KINDS,
  type GapsReconciled,
  type LoadedConfig,
  reconcileGaps,
  reconcileRun,
  type ReconcileSources,
  type RuleHit,
  type RunReconciled,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { terminalSafe } from './summary.js';

const t = terminalSafe;

/** One evidence entry as a line: where to look, then the text found there. Untrusted text is escaped. */
function evidenceLine(e: ClassEvidence): string {
  switch (e.source) {
    case 'run':
      return `run.json ${t(e.pointer)}: ${t(e.text)}`;
    case 'map':
      return `appmap.json ${t(e.pointer)}: ${t(e.text)}`;
    case 'code':
      return `code ${t(e.file)}:${e.line} (${e.record}): ${t(e.text)}`;
    case 'spec': {
      const at =
        e.ref === null
          ? t(e.doc)
          : `${t(e.ref.doc)}${e.ref.lines === null ? '' : ` line ${e.ref.lines[0]}`}`;
      return `spec ${t(e.operation)} ${t(e.pointer)} (${at}): ${t(e.text)}`;
    }
  }
}

/** A rule hit: its rule, class and confidence and the fixed sentence, then its evidence, indented. */
const hitLines = (h: RuleHit): string[] => [
  `  ${h.rule} (${h.class}, ${h.confidence}): ${h.why}`,
  ...h.evidence.map((e) => `    ${evidenceLine(e)}`),
];

/**
 * The human summary of a classification: the run and the answer, the hits it stands on (or the tied candidates), the
 * other hits by name, the notes, and the file.
 *
 * @internal exported for the CLI's tests.
 */
export function formatClassification(r: RunReconciled): string {
  const c = r.classification;
  const answer =
    c.confidence === null
      ? c.candidates.length > 0
        ? 'unknown (a tie: no class is picked)'
        : 'unknown'
      : `${c.class}, confidence ${c.confidence}`;
  const shown = new Set([...c.basis, ...c.candidates]);
  const others = c.hits.filter((h) => !shown.has(h));
  const lines = [
    `Run ${t(c.runId)} (flow ${t(r.flow)}, ${r.status}): ${answer}`,
    ...(r.operation === null ? [] : [`Spec operation: ${t(r.operation)}`]),
    ...(c.basis.length > 0 ? ['Basis:', ...c.basis.flatMap(hitLines)] : []),
    ...(c.candidates.length > 0
      ? ['Candidates:', ...c.candidates.flatMap(hitLines)]
      : []),
    ...(others.length > 0
      ? [
          `Other hits: ${others.map((h) => `${h.rule} (${h.class}, ${h.confidence})`).join(', ')}`,
        ]
      : []),
    ...(c.notes.length > 0
      ? ['Notes:', ...c.notes.map((n) => `  - ${t(n)}`)]
      : []),
    'Advice for a person, never a verdict.',
    `Classification file: ${t(r.file, Infinity)}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** The human summary of the gaps: the map read, a count per checked kind, the kinds not checked, notes and files. */
export function formatGaps(r: GapsReconciled): string {
  const g = r.gaps;
  const skipped = GAP_KINDS.filter((k) => !g.checked.includes(k));
  const lines = [
    `Coverage gaps from ${t(r.appmap, Infinity)} (${t(g.origin ?? 'no origin')}${g.truncated ? ', truncated' : ''}): ${g.gaps.length} gap(s)`,
    `Checked: ${g.checked.length === 0 ? 'nothing' : g.checked.join(', ')}`,
    ...g.checked.map(
      (k) => `  ${k}: ${g.gaps.filter((x) => x.kind === k).length}`,
    ),
    ...(skipped.length > 0
      ? [`Not checked (an input is missing): ${skipped.join(', ')}`]
      : []),
    ...r.notes.map((n) => `Note: ${t(n)}`),
    `Files: ${t(r.files.json, Infinity)}, ${t(r.files.markdown, Infinity)}`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * `flowctl reconcile <run id>` classifies one run (core `reconcileRun`, which writes `classification.json` into the
 * run directory); `flowctl reconcile --gaps` writes the coverage gaps (core `reconcileGaps`). Advice, never a verdict.
 *
 * @returns `0` whenever it ran, whatever the class or the gaps; never `1` (ADR 0036 and 0037, amendments 2026-11-12).
 * @throws {ConfigError} for a usage error (both or neither of a run id and `--gaps`, `--out` without `--gaps`) or
 *   what core refuses (a bad run id, a source outside its root, no map).
 */
export async function reconcileCmd(
  cfg: LoadedConfig,
  args: string[],
  values: Values,
  write: (text: string) => void,
): Promise<number> {
  const src: ReconcileSources = {
    code: values.code,
    appmap: values.appmap,
    spec: values.spec,
  };
  const runId = args[0];
  if (values.gaps) {
    if (runId !== undefined)
      throw new ConfigError(
        'reconcile takes a run id or --gaps, not both: flowctl reconcile <run id> | flowctl reconcile --gaps',
      );
    const r = await reconcileGaps(cfg, { ...src, out: values.out });
    write(values.json ? r.text : formatGaps(r));
    return 0;
  }
  if (runId === undefined)
    throw new ConfigError(
      'reconcile needs a run id or --gaps: flowctl reconcile <run id> | flowctl reconcile --gaps',
    );
  if (values.out !== undefined)
    throw new ConfigError(
      '--out is for reconcile --gaps; a classification is written into the run directory',
    );
  const r = await reconcileRun(cfg, runId, src);
  write(values.json ? r.text : formatClassification(r));
  return 0;
}
