/**
 * Escaping of untrusted text (spec and page text) for the conflicts files (task T4.4).
 */
import { INVISIBLE_CLASS } from '../spec/index.js';

const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'gu');
/** As {@link INVISIBLE} but without the line feed, the only control character `JSON.stringify` leaves raw (between lines). */
const HIDDEN_IN_JSON = new RegExp(`(?!\\n)[${INVISIBLE_CLASS}]`, 'gu');
const MAX_SHOWN = 500;

const marker = (c: string): string =>
  `⟨U+${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`;

/**
 * Untrusted text as one markdown code span: cut at 500 code points of the raw text (marked `…`), then invisible,
 * control and lone surrogate code points shown as `⟨U+XXXX⟩`, a leading `=`, `+`, `-` or `@` (or its fullwidth form)
 * prefixed with `'` (so a cell pasted into a spreadsheet is not a formula), and fenced with one backtick more than
 * its longest backtick run. Inside a code span markdown renders no HTML, link, emphasis or heading.
 *
 * @remarks Cutting before escaping keeps every `⟨U+XXXX⟩` marker whole. Not safe inside a GFM table cell: a `|` in
 *   the text still splits the cell, code span or not. Use it in paragraphs, list entries and headings only.
 */
export function mdCode(raw: string): string {
  const points = [...raw];
  const cut =
    points.length > MAX_SHOWN ? `${points.slice(0, MAX_SHOWN).join('')}…` : raw;
  const visible = cut.replace(INVISIBLE, (c) => [...c].map(marker).join(''));
  const safe = /^[=+\-@＝＋－＠]/u.test(visible) ? `'${visible}` : visible;
  const longest = Math.max(
    0,
    ...[...safe.matchAll(/`+/g)].map((m) => m[0].length),
  );
  const fence = '`'.repeat(longest + 1);
  return `${fence} ${safe} ${fence}`;
}

/**
 * `json` (the output of `JSON.stringify`) with every invisible or control code point still raw in it written as `\u`
 * escapes, so an editor shows no hidden or reordered text; the result parses to the same value.
 */
export function hideInvisible(json: string): string {
  return json.replace(HIDDEN_IN_JSON, (c) =>
    c
      .split('')
      .map((u) => `\\u${(u.codePointAt(0) ?? 0).toString(16).padStart(4, '0')}`)
      .join(''),
  );
}
