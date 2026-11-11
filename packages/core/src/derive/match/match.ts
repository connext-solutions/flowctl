import type { AppMap } from '../../observe/index.js';
import type { Operation } from '../../spec/index.js';
import {
  evidence,
  literals,
  routeEvidence,
  segmentEvidence,
} from './evidence.js';
import { compareEvidence, compareKeys, elementKey } from './order.js';
import { indexMap, type PageIndex, specTexts } from './sources.js';
import { fold, normText } from './text.js';
import type {
  Evidence,
  LiteralMatch,
  MatchReport,
  OperationMatch,
  ScreenCandidate,
  ScreenVerdict,
  SpecSpan,
  UnmatchedStep,
} from './types.js';

export { WEIGHTS } from './evidence.js';
/** The value a piece of evidence is counted by: the literal for labels and paths, the element for route rules. */
const scoreKey = (e: Evidence): string =>
  `${e.kind}\u0000${e.kind === 'label' || e.kind === 'path-literal' ? e.spec.text : fold(e.element.name)}`;

/** Groups evidence into screen candidates, best score first, then by path. */
function screens(
  all: readonly Evidence[],
  pages: readonly PageIndex[],
): ScreenCandidate[] {
  const out: ScreenCandidate[] = [];
  for (const p of pages) {
    const ev = all
      .filter((e) => e.element.page === p.path)
      .sort(compareEvidence);
    if (ev.length === 0) continue;
    const counted = new Map(ev.map((e) => [scoreKey(e), e.weight]));
    const score = [...counted.values()].reduce((a, b) => a + b, 0);
    out.push({
      page: p.path,
      title: p.title,
      status: p.status,
      score,
      evidence: ev,
    });
  }
  return out.sort((a, b) =>
    compareKeys([-a.score, a.page], [-b.score, b.page]),
  );
}

function verdict(candidates: readonly ScreenCandidate[]): ScreenVerdict {
  const top = candidates[0];
  if (top === undefined) return { status: 'none' };
  const tied = candidates
    .filter((c) => c.score === top.score)
    .map((c) => c.page);
  return tied.length > 1
    ? { status: 'ambiguous', pages: tied }
    : { status: 'matched', page: top.page };
}

function unmatchedSteps(
  op: Operation,
  all: readonly Evidence[],
  lits: readonly LiteralMatch[],
) {
  const out: UnmatchedStep[] = [];
  op.steps.forEach((s, i) => {
    const inStep = (sp: SpecSpan): boolean =>
      sp.path[0] === 'steps' && sp.path[1] === i;
    const missing = lits
      .filter((l) => l.elements.length === 0 && l.spans.some(inStep))
      .map((l) => l.text);
    if (missing.length > 0 || !all.some((e) => inStep(e.spec)))
      out.push({ step: i, text: normText(s), missing });
  });
  return out;
}

function matchOne(op: Operation, pages: readonly PageIndex[]): OperationMatch {
  const texts = specTexts(op);
  const lits = literals(texts, pages);
  const all: Evidence[] = [
    ...routeEvidence(texts, pages),
    ...segmentEvidence(op, pages),
  ];
  for (const l of lits)
    for (const s of l.spans)
      for (const { element, rule } of l.elements)
        all.push(
          evidence(
            l.kind === 'path' ? 'path-literal' : 'label',
            rule,
            s,
            element,
          ),
        );
  const candidates = screens(all, pages);
  return {
    operation: {
      id: op.id,
      title: op.title,
      provider: op.location.provider,
      ref: op.location.ref,
    },
    screen: verdict(candidates),
    screens: candidates,
    literals: lits,
    unmatchedSteps: unmatchedSteps(op, all, lits),
  };
}

/**
 * Joins spec operations to the screens and controls of an `AppMap`, without a model (task T4.1, ADR 0034): per
 * operation, the candidate pages with a score and the evidence of each match, every quoted literal with the
 * elements it equals, and the steps nothing matched.
 *
 * @remarks Pure and deterministic: the same operations and map give the same report, whatever their order. It
 *   invents nothing: every evidence entry cites a span of the operation's text and an element of the map. A tie at
 *   the top is `ambiguous`, never broken by order.
 * @see docs/adr/0034-spec-to-map-matching.md
 */
export function matchOperations(
  ops: readonly Operation[],
  map: AppMap,
): MatchReport {
  const index = indexMap(map);
  const sorted = [...ops].sort((a, b) =>
    compareKeys(
      [a.id, a.location.provider, a.location.ref],
      [b.id, b.location.provider, b.location.ref],
    ),
  );
  return {
    v: 1,
    origin: map.origin,
    observedAt: map.observedAt,
    truncated: map.truncated,
    operations: sorted.map((op) => matchOne(op, index.pages)),
    refusedElements: index.refused.sort((a, b) =>
      compareKeys(elementKey(a.element), elementKey(b.element)),
    ),
  };
}
