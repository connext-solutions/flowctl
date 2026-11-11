/**
 * The matcher's own text rule (ADR 0034 rule 4): the case fold. Normalisation, refusals, token-boundary
 * occurrences and quoted literals are the shared ADR 0020 rules in `spec/text.ts`.
 *
 * @see docs/adr/0034-spec-to-map-matching.md
 */

/** How two strings matched: equal after `normText`, or equal only after {@link fold}. */
export type TextRule = 'exact' | 'folded';

/**
 * The one fuzzy rule: lower case (Unicode default case mapping, locale-free), then a trailing run of spaces, `*`
 * and `:` dropped, so a required marker (`Lý do *`) or a label colon (`Lý do:`) does not hide a label.
 */
export const fold = (s: string): string =>
  s.toLowerCase().replace(/[ *:]+$/u, '');

/** How two normalised strings match, or `null`; an empty string, or one that folds to empty, never matches. */
export function compareText(a: string, b: string): TextRule | null {
  if (a === '' || b === '') return null;
  if (a === b) return 'exact';
  const fa = fold(a);
  return fa !== '' && fa === fold(b) ? 'folded' : null;
}
