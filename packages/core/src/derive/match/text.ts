/**
 * The text rules of the matcher (ADR 0034): the ADR 0020 section d normalisation and its Unicode refusals, the one
 * fuzzy rule (the case fold), token-boundary occurrences (ADR 0020 amendment 2026-11-12, section 2) and quoted
 * literals.
 *
 * @see docs/adr/0034-spec-to-map-matching.md
 */

/**
 * Why a string takes no part in a match (ADR 0020 section d): `compatibility` when its NFKC form differs from its
 * NFC form (`ﬁ`, fullwidth letters), `invisible` for a control, format, separator, private-use, unassigned or
 * default-ignorable code point (U+200B, U+202E), `digit` for a decimal digit outside ASCII.
 */
export type Refusal = 'compatibility' | 'invisible' | 'digit';

/** How two strings matched: equal after {@link normText}, or equal only after {@link fold}. */
export type TextRule = 'exact' | 'folded';

const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/u;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;
const WORDISH = /^[\p{L}\p{M}\p{N}_-]$/u;
const DIGIT = /^\p{Nd}$/u;
const QUOTED = /"([^"]+)"|“([^”]+)”/g;

/** ADR 0020 section d: Unicode NFC, then runs of ASCII whitespace collapsed to one space and trimmed. */
export const normText = (s: string): string =>
  s
    .normalize('NFC')
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim();

/**
 * The {@link Refusal} of a string already passed through {@link normText}, or `null` when it may be matched.
 *
 * @remarks Applied to the two strings being compared (a quoted literal, a page title, a control name), never to the
 *   sentence around a literal: a step with an ellipsis can still carry a label.
 */
export function refusal(normalised: string): Refusal | null {
  if (INVISIBLE.test(normalised)) return 'invisible';
  if (normalised.normalize('NFKC') !== normalised) return 'compatibility';
  if (NON_ASCII_DIGIT.test(normalised)) return 'digit';
  return null;
}

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

/** One occurrence: UTF-16 offsets `[start, end)` into the text, and whether its case equals the value's. */
export interface Occurrence {
  start: number;
  end: number;
  exact: boolean;
}

const isWordish = (c: string | undefined): boolean =>
  c !== undefined && WORDISH.test(c);
const isDigit = (c: string | undefined): boolean =>
  c !== undefined && DIGIT.test(c);
const isSep = (c: string | undefined): boolean => c === '.' || c === ',';

/** Whether code points `[i, j)` of `t` sit at token boundaries (ADR 0020 amendment 2026-11-12, section 2). */
function atBoundaries(
  t: readonly string[],
  v: readonly string[],
  i: number,
): boolean {
  const j = i + v.length;
  if (isWordish(t[i - 1]) || isWordish(t[j])) return false;
  if (isDigit(v[0]) && isSep(t[i - 1]) && isDigit(t[i - 2])) return false;
  return !(isDigit(v.at(-1)) && isSep(t[j]) && isDigit(t[j + 1]));
}

/**
 * Every occurrence of `value` in `text` at token boundaries, compared code point by code point in lower case,
 * overlaps included. Both strings are expected normalised ({@link normText}).
 */
export function occurrences(text: string, value: string): Occurrence[] {
  const t = [...text];
  const v = [...value];
  if (v.length === 0) return [];
  const lt = t.map((c) => c.toLowerCase());
  const lv = v.map((c) => c.toLowerCase());
  const offset: number[] = [0];
  for (const c of t) offset.push((offset.at(-1) ?? 0) + c.length);
  const found: Occurrence[] = [];
  for (let i = 0; i + v.length <= t.length; i++) {
    if (!lv.every((c, k) => lt[i + k] === c)) continue;
    if (!atBoundaries(t, v, i)) continue;
    found.push({
      start: offset[i] ?? 0,
      end: offset[i + v.length] ?? 0,
      exact: v.every((c, k) => t[i + k] === c),
    });
  }
  return found;
}

/** A quoted literal: the UTF-16 offsets of its inner text (without the quotes) and that text. */
export interface Quoted {
  start: number;
  end: number;
  text: string;
}

/** The literals of `text` quoted as the markdown adapter quotes a value: `"…"` or `“…”`. */
export function quotedSpans(text: string): Quoted[] {
  return [...text.matchAll(QUOTED)].map((m) => {
    const inner = m[1] ?? m[2] ?? '';
    const start = m.index + 1;
    return { start, end: start + inner.length, text: inner };
  });
}
