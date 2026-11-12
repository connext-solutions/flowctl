import { normalisePath } from '../../browser/index.js';
import { type CodeIndex, parseRoutePattern } from '../code/index.js';
import type { NearText, TextFacts } from './near.js';
import { clip, specLiterals } from './strings.js';
import type { Subject } from './subject.js';
import type {
  ClassEvidence,
  ClassifyInput,
  ClassifyLimits,
  Confidence,
  RuleHit,
} from './types.js';

/** A score of the scoring table of ADR 0036 decision 6: 3 or more is high, 2 medium, less low. */
export const confidenceOf = (score: number): Confidence =>
  score >= 3 ? 'high' : score === 2 ? 'medium' : 'low';

const both = (n: NearText): number =>
  n.code.length > 0 && n.map.length > 0 ? 1 : 0;
const foldedPoint = (n: NearText): number => (n.rule === 'folded' ? 1 : 0);

/** The near texts with the highest score, and that score. */
function best(
  near: readonly NearText[],
  score: (n: NearText) => number,
): { top: NearText[]; score: number } {
  const scored = near.map((n) => ({ n, s: score(n) }));
  const max = Math.max(...scored.map((x) => x.s));
  return { top: scored.filter((x) => x.s === max).map((x) => x.n), score: max };
}

const nearEvidence = (
  top: readonly NearText[],
  withSpec: boolean,
): ClassEvidence[] =>
  top.flatMap((n) => [...n.code, ...n.map, ...(withSpec ? n.spec : [])]);

/**
 * The label rules for a failing locator name or text `T` (ADR 0036 decision 6). The app has `T` when the code index
 * or the map states it exactly; a near text `Y` counts only when the code or the map has it.
 *
 * - `label-spec-drift` (`spec_drift`): the spec states `T`, the app does not, the app has a near `Y` the spec does
 *   not state. Score 1, plus 1 when code and map both have `Y`, plus 1 when `Y` is `folded`.
 * - `label-stale` (`stale_test`): nobody states `T`, the app has a near `Y`. Score 1 when the spec states `Y`, plus 1
 *   when code and map both have it, plus 1 when it is `folded`.
 * - `label-product-bug` (`product_bug`, medium): the spec and the code index both state `T` exactly.
 */
export function labelRules(
  subject: Subject,
  facts: TextFacts,
  limits: ClassifyLimits,
): RuleHit[] {
  if (subject.kind === 'url') return [];
  const run: ClassEvidence = {
    source: 'run',
    pointer: subject.pointer,
    text: clip(subject.text, limits.maxEvidenceText),
  };
  const hits: RuleHit[] = [];
  const appHasT = facts.code.length > 0 || facts.map.length > 0;
  const specSaysT = facts.spec.length > 0;
  const near = facts.near.filter((n) => n.code.length > 0 || n.map.length > 0);
  const drift = near.filter((n) => n.spec.length === 0);
  if (specSaysT && !appHasT && drift.length > 0) {
    const b = best(drift, (n) => 1 + both(n) + foldedPoint(n));
    hits.push({
      rule: 'label-spec-drift',
      class: 'spec_drift',
      confidence: confidenceOf(b.score),
      why: 'the spec states the failing text, the app has a near text instead',
      evidence: [run, ...facts.spec, ...nearEvidence(b.top, false)],
    });
  }
  if (!specSaysT && !appHasT && near.length > 0) {
    const b = best(
      near,
      (n) => (n.spec.length > 0 ? 1 : 0) + both(n) + foldedPoint(n),
    );
    hits.push({
      rule: 'label-stale',
      class: 'stale_test',
      confidence: confidenceOf(b.score),
      why: 'neither the spec nor the app states the failing text, the app has a near text',
      evidence: [run, ...nearEvidence(b.top, true)],
    });
  }
  if (specSaysT && facts.code.length > 0)
    hits.push({
      rule: 'label-product-bug',
      class: 'product_bug',
      confidence: 'medium',
      why: 'the spec and the code both state the failing text, and the run did not find it',
      evidence: [run, ...facts.spec, ...facts.code, ...facts.map],
    });
  return hits;
}

/** The path of a spec literal that names an address: from its `/`, cut at `?` or `#`. */
const literalAddress = (text: string): string | null =>
  text.startsWith('/') ? (text.split(/[?#]/)[0] ?? null) : null;

/**
 * A path as `findRoute` compares it: percent-decoded, dot segments resolved, no empty segment or trailing `/`
 * (except the root), NFC; `null` when it is refused.
 */
const pathKey = (path: string): string | null =>
  normalisePath(path)?.normalize('NFC') ?? null;

/** Whether a route pattern has a rest segment (`*`, `**`, `:x*`, `:x+`), so it matches every path below it. */
const isCatchAll = (pattern: string): boolean =>
  parseRoutePattern(pattern).some((s) => s.kind === 'rest');

/** Code routes matching `path`, catch-all routes left out, cited; `dropped` when a catch-all route was left out. */
function routesOf(
  code: CodeIndex,
  path: string,
  limits: ClassifyLimits,
): { evidence: ClassEvidence[]; dropped: boolean } {
  const all = code.findRoute(path).matches;
  const kept = all.filter((r) => !isCatchAll(r.path));
  return {
    dropped: kept.length < all.length,
    evidence: kept.slice(0, limits.maxEvidencePerSource).map((r) => ({
      source: 'code',
      record: 'route',
      file: clip(r.file, limits.maxEvidenceText),
      line: r.line,
      text: clip(r.path, limits.maxEvidenceText),
    })),
  };
}

/**
 * The route rules for a failed `url` assertion with a literal expected path `E`, the page on path `A`; they need the
 * code index (ADR 0036 decision 7). The app has a path when the index has a route matching it or the map a page on it.
 *
 * - `route-spec-drift` (`spec_drift`): the spec quotes `E`, the app has no `E`, the app has `A`. Score 2, plus 1 when
 *   code and map both have `A`.
 * - `route-stale` (`stale_test`): the spec does not quote `E`, the app has no `E`, the app has `A`. Score 1, plus 1
 *   when the spec quotes `A`, plus 1 when code and map both have `A`.
 * - `route-product-bug` (`product_bug`, medium): the spec quotes `E` and the index has a route for it.
 *
 * A catch-all route (a pattern with a rest segment) matches every path, so it never says the app has `E` or `A`;
 * when one was left out, the note `catch-all route ignored` says so. Paths of the map and the spec are compared
 * after the normalisation `findRoute` applies, so `/x/` and `/x` agree.
 */
export function routeRules(
  subject: Subject,
  input: ClassifyInput,
  limits: ClassifyLimits,
): { hits: RuleHit[]; notes: string[] } {
  const code = input.code;
  if (subject.kind !== 'url' || code === undefined)
    return { hits: [], notes: [] };
  const literals =
    input.spec === undefined ? [] : specLiterals(input.spec, limits);
  const says = (p: string) => {
    const key = pathKey(p);
    return literals
      .filter((l) => {
        const a = literalAddress(l.text);
        return key !== null && a !== null && pathKey(a) === key;
      })
      .map((l) => l.evidence)
      .slice(0, limits.maxEvidencePerSource);
  };
  const pages = (p: string): ClassEvidence[] => {
    const key = pathKey(p);
    return (input.map?.pages ?? []).flatMap((pg, i): ClassEvidence[] =>
      key !== null && pathKey(pg.path) === key
        ? [
            {
              source: 'map',
              pointer: `/pages/${i}/path`,
              text: clip(pg.path, limits.maxEvidenceText),
            },
          ]
        : [],
    );
  };
  const run: ClassEvidence[] = [
    {
      source: 'run',
      pointer: subject.pointer,
      text: clip(subject.expected, limits.maxEvidenceText),
    },
    {
      source: 'run',
      pointer: subject.gotPointer,
      text: clip(subject.got, limits.maxEvidenceText),
    },
  ];
  const routesE = routesOf(code, subject.expected, limits);
  const routesA = routesOf(code, subject.got, limits);
  const [rE, mE, sE] = [
    routesE.evidence,
    pages(subject.expected),
    says(subject.expected),
  ];
  const [rA, mA, sA] = [
    routesA.evidence,
    pages(subject.got),
    says(subject.got),
  ];
  const notes =
    routesE.dropped || routesA.dropped ? ['catch-all route ignored'] : [];
  const hits: RuleHit[] = [];
  const appHasA = rA.length > 0 || mA.length > 0;
  const bothA = rA.length > 0 && mA.length > 0 ? 1 : 0;
  if (rE.length === 0 && mE.length === 0 && appHasA)
    hits.push(
      sE.length > 0
        ? {
            rule: 'route-spec-drift',
            class: 'spec_drift',
            confidence: confidenceOf(2 + bothA),
            why: 'the spec quotes the expected path, the app has no route for it and has the path the page was on',
            evidence: [...run, ...sE, ...rA, ...mA],
          }
        : {
            rule: 'route-stale',
            class: 'stale_test',
            confidence: confidenceOf(1 + (sA.length > 0 ? 1 : 0) + bothA),
            why: 'the app has no route for the expected path and has the path the page was on',
            evidence: [...run, ...sA, ...rA, ...mA],
          },
    );
  if (sE.length > 0 && rE.length > 0)
    hits.push({
      rule: 'route-product-bug',
      class: 'product_bug',
      confidence: 'medium',
      why: 'the spec and the code both have the expected path, and the page was elsewhere',
      evidence: [...run, ...sE, ...rE],
    });
  return { hits, notes };
}
