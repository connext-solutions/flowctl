/**
 * Escaping of untrusted text (spec and page text) for the conflicts files (task T4.4).
 */

const INVISIBLE =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu;
/** As {@link INVISIBLE} but without the line feed, the only control character `JSON.stringify` leaves raw (between lines). */
const HIDDEN_IN_JSON =
  /(?!\n)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Default_Ignorable_Code_Point}]/gu;
const MAX_SHOWN = 500;

/**
 * Untrusted text as one markdown code span: invisible and control code points shown as `⟨U+XXXX⟩`, a leading `=`,
 * `+`, `-` or `@` prefixed with `'` (so a cell pasted into a spreadsheet is not a formula), cut at 500 code points,
 * and fenced with one backtick more than its longest backtick run. Inside a code span markdown renders no HTML, link,
 * emphasis or heading.
 */
export function mdCode(raw: string): string {
  const visible = raw.replace(INVISIBLE, (c) =>
    [...c]
      .map(
        (p) =>
          `⟨U+${(p.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`,
      )
      .join(''),
  );
  const points = [...(/^[=+\-@]/.test(visible) ? `'${visible}` : visible)];
  const safe =
    points.length > MAX_SHOWN
      ? `${points.slice(0, MAX_SHOWN).join('')}…`
      : points.join('');
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
