import { textFacts } from './near.js';
import { errorKindRule, networkRules } from './run-rules.js';
import { labelRules, routeRules } from './spec-rules.js';
import { failedCalls, subjectOf } from './subject.js';
import {
  CLASSIFY_LIMITS,
  type Classification,
  type ClassifyInput,
  type ClassifyLimits,
  type Confidence,
  RULE_IDS,
  type RuleHit,
} from './types.js';

const RANK: Record<Confidence, number> = { high: 3, medium: 2, low: 1 };

/** The app's own origins: the caller's, else the map's, else `null` (not known). */
function originsOf(input: ClassifyInput): readonly string[] | null {
  if (input.origins !== undefined) return input.origins;
  return input.map === undefined ? null : [input.map.origin];
}

/** Every rule that fires for a failed run, in {@link RULE_IDS} order. */
function failedHits(
  input: ClassifyInput,
  limits: ClassifyLimits,
): { hits: RuleHit[]; notes: string[] } {
  const hits = networkRules(
    failedCalls(input.result),
    originsOf(input),
    limits,
  );
  const { subject, notes } = subjectOf(input.result, limits);
  if (subject !== null) {
    if (subject.kind !== 'url') {
      const facts = textFacts(
        subject.text,
        subject.kind === 'locator' ? subject.role : null,
        input,
        limits,
      );
      hits.push(...labelRules(subject, facts, limits));
    } else if (input.code === undefined)
      notes.push('no code index: route rules not run');
    hits.push(...routeRules(subject, input, limits));
  }
  return { hits, notes };
}

/**
 * Picks the class from the hits (ADR 0036 decision 4): the highest confidence wins; when hits of two or more classes
 * share it, the class is `unknown` and they are `candidates`.
 */
function decide(
  runId: string,
  hits: RuleHit[],
  notes: string[],
): Classification {
  const sorted = [...hits].sort(
    (a, b) => RULE_IDS.indexOf(a.rule) - RULE_IDS.indexOf(b.rule),
  );
  const top = Math.max(0, ...sorted.map((h) => RANK[h.confidence]));
  const best = sorted.filter((h) => RANK[h.confidence] === top);
  const classes = new Set(best.map((h) => h.class));
  const first = best[0];
  if (first === undefined || classes.size !== 1)
    return {
      runId,
      class: 'unknown',
      confidence: null,
      basis: [],
      candidates: classes.size > 1 ? best : [],
      hits: sorted,
      notes,
    };
  return {
    runId,
    class: first.class,
    confidence: first.confidence,
    basis: best,
    candidates: [],
    hits: sorted,
    notes,
  };
}

/**
 * Classifies one failed or errored run as a product bug, spec drift, stale test, environment problem or unknown,
 * with fixed rules and the evidence each used (ADR 0036). Pure: no model, no network, no file system; the same input
 * gives the same answer.
 *
 * @remarks The answer is advice for a person, never a verdict, and it never changes the run's verdict (ADR 0004). An
 *   errored run is judged by its error kind alone; a passed run, or an error kind the rules do not class, is
 *   `unknown`. Every string from the page, the spec or the code is compared as data and cut before it enters evidence.
 * @example classifyFailure({ result, code: buildCodeIndex(root), map, spec: operation })
 * @see docs/adr/0036-failure-classifier.md
 */
export function classifyFailure(
  input: ClassifyInput,
  limits: ClassifyLimits = CLASSIFY_LIMITS,
): Classification {
  const { result } = input;
  if (result.status === 'passed')
    return decide(result.runId, [], ['the run passed: nothing to classify']);
  if (result.status === 'error') {
    const hit = errorKindRule(result, limits);
    const notes =
      hit === null
        ? [`error kind ${result.error?.kind ?? 'missing'} is not classed`]
        : [];
    return decide(result.runId, hit === null ? [] : [hit], notes);
  }
  const { hits, notes } = failedHits(input, limits);
  if (hits.length === 0) notes.push('no rule found evidence');
  return decide(result.runId, hits, notes);
}
