import {
  normText,
  occurrences,
  type Operation,
  quotedSpans,
  refusal,
} from '../../spec/index.js';
import { compareKeys, elementKey } from './order.js';
import type { PageIndex, SpecText } from './sources.js';
import { compareText, type TextRule } from './text.js';
import type {
  MatchEvidence,
  MatchEvidenceKind,
  LiteralMatch,
  MapElement,
  SpecSpan,
} from './types.js';

/**
 * What each kind of evidence adds to a page's score (ADR 0034). A page counts each kind once per matched value: a
 * title equal to three headings adds 3, not 9; each distinct label adds 2.
 */
export const WEIGHTS: Readonly<Record<MatchEvidenceKind, number>> = {
  'title-equal': 3,
  'path-literal': 3,
  'title-mention': 2,
  label: 2,
  'doc-segment': 1,
};

const span = (t: SpecText, start: number, end: number): SpecSpan => ({
  path: t.path,
  start,
  end,
  text: t.text.slice(start, end),
});

/** One piece of evidence, with the weight of its kind. */
export const evidence = (
  kind: MatchEvidenceKind,
  rule: TextRule,
  spec: SpecSpan,
  element: MapElement,
): MatchEvidence => ({ kind, rule, weight: WEIGHTS[kind], spec, element });

/** `title-equal` (title and headings) and `title-mention` (title, headings and steps) against every page title. */
export function routeEvidence(
  texts: readonly SpecText[],
  pages: readonly PageIndex[],
) {
  const out: MatchEvidence[] = [];
  for (const t of texts) {
    if (t.role === 'expected') continue;
    for (const p of pages) {
      const title = p.titleElement;
      if (title === null) continue;
      const rule = t.role === 'step' ? null : compareText(t.text, title.text);
      if (rule !== null) {
        out.push(
          evidence(
            'title-equal',
            rule,
            span(t, 0, t.text.length),
            title.element,
          ),
        );
        continue;
      }
      for (const o of occurrences(t.text, title.text))
        out.push(
          evidence(
            'title-mention',
            o.exact ? 'exact' : 'folded',
            span(t, o.start, o.end),
            title.element,
          ),
        );
    }
  }
  return out;
}

/** `doc-segment`: each folder of `location.ref` against the first segment of every page path. */
export function segmentEvidence(op: Operation, pages: readonly PageIndex[]) {
  const ref = normText(op.location.ref);
  const out: MatchEvidence[] = [];
  let start = 0;
  for (const seg of ref.split('/').slice(0, -1)) {
    const spec: SpecSpan = {
      path: ['location', 'ref'],
      start,
      end: start + seg.length,
      text: seg,
    };
    start += seg.length + 1;
    if (refusal(seg) !== null) continue;
    for (const p of pages) {
      const rule = compareText(seg, p.path.split('/')[1] ?? '');
      if (rule !== null)
        out.push(
          evidence('doc-segment', rule, spec, {
            kind: 'path',
            page: p.path,
            name: p.path,
          }),
        );
    }
  }
  return out;
}

/** The elements a literal equals on every page: a `/…` literal against page paths, any other against names. */
function literalElements(literal: LiteralMatch, pages: readonly PageIndex[]) {
  if (literal.refused !== null) return;
  for (const p of pages) {
    if (literal.kind === 'path') {
      if (literal.text.split(/[?#]/)[0] === p.path)
        literal.elements.push({
          element: { kind: 'path', page: p.path, name: p.path },
          rule: 'exact',
        });
      continue;
    }
    for (const n of p.names) {
      const rule = compareText(literal.text, n.text);
      if (rule !== null) literal.elements.push({ element: n.element, rule });
    }
  }
  const key = (e: LiteralMatch['elements'][number]) => [
    e.rule === 'exact' ? 0 : 1,
    ...elementKey(e.element),
  ];
  literal.elements.sort((a, b) => compareKeys(key(a), key(b)));
}

/** Every quoted literal of the steps and expected items, grouped by normalised text, sorted by it. */
export function literals(
  texts: readonly SpecText[],
  pages: readonly PageIndex[],
) {
  const byText = new Map<string, LiteralMatch>();
  for (const t of texts) {
    if (t.role !== 'step' && t.role !== 'expected') continue;
    for (const q of quotedSpans(t.text)) {
      const text = normText(q.text);
      if (text === '') continue;
      const found = byText.get(text) ?? {
        kind: text.startsWith('/') ? 'path' : 'label',
        text,
        spans: [],
        elements: [],
        refused: refusal(text),
      };
      byText.set(text, found);
      found.spans.push(span(t, q.start, q.end));
    }
  }
  const out = [...byText.values()].sort((a, b) =>
    compareKeys([a.text], [b.text]),
  );
  for (const l of out) literalElements(l, pages);
  return out;
}
