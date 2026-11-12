/**
 * The ADR 0020 text rules every reader of spec text shares: the section d normalisation and its Unicode refusals,
 * token-boundary occurrences (amendment 2026-11-12, section 2) and quoted literals. The markdown adapter, the
 * matcher (ADR 0034) and the provenance layer read spec text through them, so the rules exist once.
 *
 * @see docs/adr/0020-assertion-provenance.md
 * @see docs/adr/0034-spec-to-map-matching.md
 */

/**
 * The code points ADR 0020 section d calls invisible, as the inside of a regex character class (use with the `u`
 * flag): control, format, lone surrogate, line and paragraph separator, private-use, unassigned and
 * default-ignorable code points.
 *
 * @example new RegExp(`[${INVISIBLE_CLASS}]`, 'gu')
 */
export const INVISIBLE_CLASS =
  '\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cn}\\p{Default_Ignorable_Code_Point}';

/**
 * Why a string takes no part in a match (ADR 0020 section d): `compatibility` when its NFKC form differs from its
 * NFC form (`ﬁ`, fullwidth letters), `invisible` for a code point of {@link INVISIBLE_CLASS} (U+200B, U+202E),
 * `digit` for a decimal digit outside ASCII.
 */
export type Refusal = 'compatibility' | 'invisible' | 'digit';

const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');
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

/** One occurrence: UTF-16 offsets `[start, end)` into the text, and whether its case equals the value's. */
export interface Occurrence {
  start: number;
  end: number;
  exact: boolean;
}

/** A letter, mark, number, `_` or `-` (ADR 0020 rule 1), or a refused invisible code point (ADR 0034: fail closed). */
const isWordish = (c: string | undefined): boolean =>
  c !== undefined && (WORDISH.test(c) || INVISIBLE.test(c));
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
 *
 * @remarks Lower case is taken per code point here, where the matcher's case fold lower-cases the whole string; they
 *   differ where one code point lower-cases to several (İ), or where the mapping depends on context: `İ` does not
 *   occur in `i̇`. An invisible code point next to the value is not a boundary, so `Lab` is not found in `Lab\u200bel`.
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

/**
 * Whether `value` occurs in `text` at token boundaries: the same answer as `occurrences(text, value).length > 0`,
 * found in time linear in both lengths (a KMP scan over the per-code-point lower case, stopping at the first hit at
 * boundaries), so a hostile text with many hits that are not at boundaries costs no more than one pass.
 */
export function containsAtBoundaries(text: string, value: string): boolean {
  const v = [...value];
  if (v.length === 0) return false;
  const t = [...text];
  if (v.length > t.length) return false;
  const lv = v.map((c) => c.toLowerCase());
  const fail: number[] = [0];
  for (let i = 1, k = 0; i < lv.length; i++) {
    while (k > 0 && lv[i] !== lv[k]) k = fail[k - 1] ?? 0;
    if (lv[i] === lv[k]) k++;
    fail.push(k);
  }
  for (let i = 0, k = 0; i < t.length; i++) {
    const c = t[i]?.toLowerCase();
    while (k > 0 && c !== lv[k]) k = fail[k - 1] ?? 0;
    if (c === lv[k]) k++;
    if (k === lv.length) {
      if (atBoundaries(t, v, i + 1 - k)) return true;
      k = fail[k - 1] ?? 0;
    }
  }
  return false;
}

/** A quoted literal: the UTF-16 offsets of its inner text (without the quotes) and that text. */
export interface Quoted {
  start: number;
  end: number;
  text: string;
}

/** The literals of `text` quoted as spec text quotes a value: `"…"` or `“…”`, the inner text raw. */
export function quotedSpans(text: string): Quoted[] {
  return [...text.matchAll(QUOTED)].map((m) => {
    const inner = m[1] ?? m[2] ?? '';
    const start = m.index + 1;
    return { start, end: start + inner.length, text: inner };
  });
}
