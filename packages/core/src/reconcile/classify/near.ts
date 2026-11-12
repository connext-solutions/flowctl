import { compareText } from '../../derive/index.js';
import { containsAtBoundaries } from '../../spec/index.js';
import {
  type Cited,
  codeExact,
  codeStrings,
  mapStrings,
  specLiterals,
} from './strings.js';
import type { ClassEvidence, ClassifyInput, ClassifyLimits } from './types.js';

/**
 * How a string of the app is near the failing text (ADR 0036 decision 5): `folded` when they are equal only after the
 * ADR 0034 case fold, `contains` when one occurs in the other at token boundaries (ADR 0020 amendment 2026-11-12,
 * section 2), case-insensitive.
 */
export type Nearness = 'folded' | 'contains';

/** A text of the app (code or page) near the failing text, where it was found, and where the spec states it. */
export interface NearText {
  text: string;
  rule: Nearness;
  code: ClassEvidence[];
  map: ClassEvidence[];
  spec: ClassEvidence[];
}

/**
 * What the code index, the map and the spec say about one failing text: where each states it exactly, and the near
 * texts the app has instead. A list is empty when its input was not given. `notes` are fixed sentences about a
 * search cut short.
 */
export interface TextFacts {
  spec: ClassEvidence[];
  code: ClassEvidence[];
  map: ClassEvidence[];
  near: NearText[];
  notes: string[];
}

/** The failing text, its lower case and its length in code points, computed once per search. */
interface Probe {
  text: string;
  lower: string;
  points: number;
}

/**
 * Whether `s` (of `points` code points) is a `contains` near text of the probe: both at least 2 code points, and one
 * occurs in the other at token boundaries, case-insensitive. `s` is assumed not equal and not `folded`.
 */
function contains(p: Probe, s: string, points: number): boolean {
  if (p.points < 2 || points < 2) return false;
  const ls = s.toLowerCase();
  if (ls.includes(p.lower) && containsAtBoundaries(s, p.text)) return true;
  return p.lower.includes(ls) && containsAtBoundaries(p.text, s);
}

const evidenceOf = (list: readonly Cited[], max: number): ClassEvidence[] =>
  list.slice(0, max).map((c) => c.evidence);

const byText = (list: readonly Cited[], text: string): Cited[] =>
  list.filter((c) => c.text === text);

/**
 * Gathers the facts for the failing text `t`; `role` limits page strings to controls and fields of that role (a
 * locator), `null` takes titles too (a text assertion).
 *
 * @remarks When any near text is `folded`, the `contains` ones are not searched; otherwise the search stops at the
 *   first `maxNear` distinct `contains` texts in index order (code labels, code messages, then the map), or when the
 *   code points it has read (each string's plus the failing text's) would pass `maxComparedPoints`, with the note
 *   `near search stopped at its budget`. Near texts are sorted by UTF-16 code units and cut to `maxNear`. Spec
 *   literals are compared exactly, never by nearness: a near text counts as stated by the spec only when a literal
 *   equals it.
 */
export function textFacts(
  t: string,
  role: string | null,
  input: ClassifyInput,
  limits: ClassifyLimits,
): TextFacts {
  const spec = input.spec === undefined ? [] : specLiterals(input.spec, limits);
  const code = input.code === undefined ? [] : codeStrings(input.code, limits);
  const map =
    input.map === undefined ? [] : mapStrings(input.map, role, limits);
  const app = [...code, ...map];
  const folded = new Set(
    app
      .filter((c) => c.text !== t && compareText(t, c.text) === 'folded')
      .map((c) => c.text),
  );
  const probe: Probe = {
    text: t,
    lower: t.toLowerCase(),
    points: [...t].length,
  };
  const contained = new Set<string>();
  const notes: string[] = [];
  let read = 0;
  for (const c of folded.size > 0 ? [] : app) {
    if (contained.size >= limits.maxNear) break;
    if (c.text === t || contained.has(c.text)) continue;
    const points = [...c.text].length;
    read += points + probe.points;
    if (read > limits.maxComparedPoints) {
      notes.push('near search stopped at its budget');
      break;
    }
    if (contains(probe, c.text, points)) contained.add(c.text);
  }
  const rule: Nearness = folded.size > 0 ? 'folded' : 'contains';
  const near = [...(folded.size > 0 ? folded : contained)]
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, limits.maxNear)
    .map((text): NearText => ({
      text,
      rule,
      code: evidenceOf(byText(code, text), limits.maxEvidencePerSource),
      map: evidenceOf(byText(map, text), limits.maxEvidencePerSource),
      spec: evidenceOf(byText(spec, text), limits.maxEvidencePerSource),
    }));
  return {
    spec: evidenceOf(byText(spec, t), limits.maxEvidencePerSource),
    code:
      input.code === undefined
        ? []
        : evidenceOf(
            codeExact(input.code, t, limits),
            limits.maxEvidencePerSource,
          ),
    map: evidenceOf(byText(map, t), limits.maxEvidencePerSource),
    near,
    notes,
  };
}
