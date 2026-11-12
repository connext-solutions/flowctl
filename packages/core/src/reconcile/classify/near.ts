import { compareText } from '../../derive/index.js';
import { occurrences } from '../../spec/index.js';
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
 * texts the app has instead. A list is empty when its input was not given.
 */
export interface TextFacts {
  spec: ClassEvidence[];
  code: ClassEvidence[];
  map: ClassEvidence[];
  near: NearText[];
}

/** How `s` is near `t`, or `null` when it is equal or not near. */
export function nearness(t: string, s: string): Nearness | null {
  if (s === t) return null;
  if (compareText(t, s) === 'folded') return 'folded';
  if ([...t].length < 2 || [...s].length < 2) return null;
  const lt = t.toLowerCase();
  const ls = s.toLowerCase();
  if (ls.includes(lt) && occurrences(s, t).length > 0) return 'contains';
  if (lt.includes(ls) && occurrences(t, s).length > 0) return 'contains';
  return null;
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
 *   first `maxNear` distinct `contains` texts in index order (code labels, code messages, then the map), which bounds
 *   the work on a hostile index. Near texts are sorted by UTF-16 code units and cut to `maxNear`. Spec literals are compared exactly, never by nearness: a near text counts as stated
 *   by the spec only when a literal equals it.
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
    app.filter((c) => nearness(t, c.text) === 'folded').map((c) => c.text),
  );
  const contained = new Set<string>();
  for (const c of folded.size > 0 ? [] : app) {
    if (contained.size >= limits.maxNear) break;
    if (nearness(t, c.text) === 'contains') contained.add(c.text);
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
  };
}
