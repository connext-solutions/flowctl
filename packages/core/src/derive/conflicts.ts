import { join } from 'node:path';
import { ensureDirInside, writeFileNoFollow } from '../foundation/index.js';
import { hideInvisible, mdCode } from './escape.js';
import type {
  LiteralMatch,
  MatchReport,
  OperationMatch,
  Refusal,
  SpecPath,
  SpecSpan,
} from './match/index.js';

/**
 * A disagreement between the spec and the app map, for a business analyst to settle (task T4.4):
 * - `page_missing`: no page of the map matches the operation;
 * - `page_ambiguous`: several pages match it equally well;
 * - `label_not_on_screen`: a step quotes a label that is not a control or field of the matched screen, though
 *   another page has it;
 * - `label_not_found`: a step quotes a label no page has;
 * - `path_not_found`: a quoted address (`/…`) names no page of the map;
 * - `expected_not_observed`: an expected item quotes a text the map never holds (a read-only crawl records titles,
 *   controls and fields, not messages shown after an action);
 * - `text_refused`: a quoted literal the Unicode rules refuse (ADR 0020 section d), so it cannot be checked.
 */
export type ConflictKind =
  | 'page_missing'
  | 'page_ambiguous'
  | 'label_not_on_screen'
  | 'label_not_found'
  | 'path_not_found'
  | 'expected_not_observed'
  | 'text_refused';

/** One disagreement: the operation, the quoted literal and its spans (or none), the screen and the pages involved. */
export interface Conflict {
  kind: ConflictKind;
  operation: OperationMatch['operation'];
  text: string | null;
  spans: SpecSpan[];
  screen: string | null;
  pages: string[];
  reason: Refusal | null;
}

const inSteps = (s: SpecSpan): boolean => s.path[0] === 'steps';

/** The conflict a literal gives on an operation whose screen is `screen` (or `null` when there is none), if any. */
function literalConflict(
  l: LiteralMatch,
  screen: string | null,
): Omit<Conflict, 'operation'> | null {
  const base = { text: l.text, spans: l.spans, screen, reason: null };
  const seen = [...new Set(l.elements.map((e) => e.element.page))].sort();
  if (l.refused !== null)
    return { ...base, kind: 'text_refused', pages: [], reason: l.refused };
  if (l.kind === 'path')
    return seen.length === 0
      ? { ...base, kind: 'path_not_found', pages: [] }
      : null;
  if (!l.spans.some(inSteps))
    return seen.length === 0
      ? { ...base, kind: 'expected_not_observed', pages: [] }
      : null;
  if (seen.length === 0) return { ...base, kind: 'label_not_found', pages: [] };
  if (screen !== null && !seen.includes(screen))
    return { ...base, kind: 'label_not_on_screen', pages: seen };
  return null;
}

/**
 * The spec ≠ app disagreements of a match report, in the report's order (operations by id, literals by text).
 *
 * @remarks Built only from the report: every conflict names a literal and its spans or a screen verdict, never a
 *   guess. With no matched screen, a label is checked against every page only.
 * @see docs/adr/0034-spec-to-map-matching.md
 */
export function findConflicts(report: MatchReport): Conflict[] {
  const out: Conflict[] = [];
  for (const m of report.operations) {
    const { operation } = m;
    const screen = m.screen.status === 'matched' ? m.screen.page : null;
    if (m.screen.status === 'none')
      out.push({
        kind: 'page_missing',
        operation,
        text: null,
        spans: [],
        screen,
        pages: [],
        reason: null,
      });
    if (m.screen.status === 'ambiguous')
      out.push({
        kind: 'page_ambiguous',
        operation,
        text: null,
        spans: [],
        screen,
        pages: m.screen.pages,
        reason: null,
      });
    for (const l of m.literals) {
      const c = literalConflict(l, screen);
      if (c !== null) out.push({ ...c, operation });
    }
  }
  return out;
}

/** Where a span sits, for a reader: `step 2`, `expected item 1`, `heading`, `title`, `source path`. */
function where(path: SpecPath): string {
  const [field, index] = path;
  const n = typeof index === 'number' ? index + 1 : 0;
  if (field === 'steps') return `step ${n}`;
  if (field === 'expected')
    return path[2] === 'context'
      ? `heading of expected item ${n}`
      : `expected item ${n}`;
  return field === 'location' ? 'source path' : 'title';
}

const places = (spans: readonly SpecSpan[]): string =>
  [...new Set(spans.map((s) => where(s.path)))].join(', ');
const pageList = (pages: readonly string[]): string =>
  pages.map(mdCode).join(', ');

/** One conflict as a markdown list entry. */
function entry(c: Conflict): string {
  const lit = `${mdCode(c.text ?? '')} (${places(c.spans)})`;
  const screen = mdCode(c.screen ?? '');
  switch (c.kind) {
    case 'page_missing':
      return '- **Screen not found**: no page of the app map matches this operation.';
    case 'page_ambiguous':
      return `- **Screen unclear**: these pages match equally well: ${pageList(c.pages)}.`;
    case 'label_not_on_screen':
      return `- **Label not on the screen**: ${lit} is not a control or field of ${screen}; seen on ${pageList(c.pages)}.`;
    case 'label_not_found':
      return `- **Label not found**: ${lit} is not a control or field of any page.`;
    case 'path_not_found':
      return `- **Address not found**: ${lit} is not a page of the app map.`;
    case 'expected_not_observed':
      return `- **Expected text not seen**: ${lit} is not in the app map; check it on the screen after the action.`;
    case 'text_refused':
      return `- **Text cannot be checked**: ${lit} holds characters that are refused (${c.reason ?? ''}).`;
  }
}

/**
 * The conflicts as a markdown file for a business analyst: a header with the map's origin and time, then one section
 * per operation with its source and one entry per conflict. Every untrusted string goes through {@link mdCode}.
 */
export function conflictsMarkdown(
  report: MatchReport,
  conflicts: readonly Conflict[],
): string {
  const lines = [
    '# Spec and app disagreements',
    '',
    `App map of ${mdCode(report.origin)}, observed ${mdCode(report.observedAt)}: ${conflicts.length} to check.`,
    'The app map is a read-only crawl: it holds page titles, controls and form fields, not messages shown after an action.',
  ];
  if (report.truncated)
    lines.push(
      'The crawl stopped early, so a page reported missing may only be unvisited.',
    );
  let current = '';
  for (const c of conflicts) {
    const key = JSON.stringify([
      c.operation.id,
      c.operation.provider,
      c.operation.ref,
    ]);
    if (key !== current) {
      current = key;
      lines.push(
        '',
        `## ${mdCode(c.operation.id)} ${mdCode(c.operation.title)}`,
        '',
      );
      lines.push(
        `Source: ${mdCode(c.operation.provider)} ${mdCode(c.operation.ref)}`,
        '',
      );
    }
    lines.push(entry(c));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The conflicts as JSON (`v: 1`, the map's origin, time and `truncated`, the conflicts), with every non-ASCII
 * invisible or control code point written as a `\u` escape, so the file shows no hidden text in an editor.
 */
export function conflictsJson(
  report: MatchReport,
  conflicts: readonly Conflict[],
): string {
  const doc = {
    v: 1,
    origin: report.origin,
    observedAt: report.observedAt,
    truncated: report.truncated,
    conflicts,
  };
  const text = hideInvisible(JSON.stringify(doc, null, 2));
  return `${text}\n`;
}

/**
 * Writes `conflicts.md` and `conflicts.json` into `dir`, which must be inside `root`, and returns their paths.
 *
 * @throws {ConfigError} when `dir` is not inside `root` or a component on the way is a symlink or a file.
 */
export function writeConflicts(
  dir: string,
  root: string,
  report: MatchReport,
  conflicts: readonly Conflict[] = findConflicts(report),
): { markdown: string; json: string } {
  const real = ensureDirInside(dir, root);
  const markdown = join(real, 'conflicts.md');
  const json = join(real, 'conflicts.json');
  writeFileNoFollow(markdown, conflictsMarkdown(report, conflicts));
  writeFileNoFollow(json, conflictsJson(report, conflicts));
  return { markdown, json };
}
