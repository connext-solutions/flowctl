import { quoted, regexEnd, template } from './literals.js';

/**
 * A token of JavaScript-like source: an identifier, a string literal with its escapes decoded (a template
 * without substitutions counts), a number, or one punctuation character. `line` is 1-based.
 */
export interface Token {
  type: 'id' | 'str' | 'num' | 'punct';
  value: string;
  line: number;
}

const ID = /[\p{ID_Start}$_][\p{ID_Continue}$\u200c\u200d]*/uy;
const NUM =
  /(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)n?/y;
const SPACE = /[ \t\r\f\v\u00a0\ufeff]+/y;

/** Punctuation and keywords after which a `/` starts a regular expression rather than a division. */
const REGEX_AFTER = new Set([
  '(',
  ',',
  '=',
  ':',
  '[',
  '!',
  '&',
  '|',
  '?',
  '{',
  ';',
  '+',
  '-',
  '*',
  '%',
  '~',
  '^',
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

/**
 * Splits JavaScript, TypeScript or JSX source into {@link Token}s, skipping comments, whitespace and regular
 * expressions, in one linear pass.
 *
 * @remarks Not a parser: JSX text is read as code. A stray quote in JSX text (`Don't`) whose line ends before a
 *   closing quote becomes a punctuation token and the lexer goes on after it, so the damage stays on that line.
 *   Each unclosed scan is remembered by its opening character (`'`, `"`, `/`) up to where it stopped: a later
 *   opening of the same kind before that point is punctuation without a new scan, so a line is scanned a fixed
 *   number of times whatever it holds. What this loses is a literal opened inside that stretch by a character the
 *   failed scan read as escaped (`'\'…'` after an unclosed `'`), or a regular expression opened there (its body
 *   is then read as code); the other quote kind and the following lines are read as usual.
 *   A `/` after `<`, `>`, `)`, `]` or `}` is a division, so `</Route>` and `{x} />` lex as punctuation. A
 *   `\u{…}` escape has at most 8 hex digits.
 */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  const unclosed = new Map<string, number>();
  let line = 1;
  let i = 0;
  const push = (type: Token['type'], value: string, at = line): void => {
    out.push({ type, value, line: at });
  };
  const known = (c: string): boolean => (unclosed.get(c) ?? -1) > i;
  while (i < src.length) {
    const c = src[i] ?? '';
    SPACE.lastIndex = i;
    if (SPACE.test(src)) {
      i = SPACE.lastIndex;
      continue;
    }
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end < 0 ? src.length : end;
    } else if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (src[j] === '\n') line++;
      i = stop;
    } else if (c === '"' || c === "'") {
      const s = known(c) ? undefined : quoted(src, i);
      if (s === undefined || 'stop' in s) {
        if (s !== undefined) unclosed.set(c, s.stop);
        push('punct', c);
        i++;
      } else {
        push('str', s.value);
        line += s.lines;
        i = s.end;
      }
    } else if (c === '`') {
      const t = template(src, i);
      if (t.value !== null) push('str', t.value);
      line += t.lines;
      i = t.end;
    } else if (c === '/' && regexMayStart(out.at(-1))) {
      const end = known(c) ? undefined : regexEnd(src, i);
      if (end === undefined || typeof end !== 'number') {
        if (end !== undefined) unclosed.set(c, end.stop);
        push('punct', c);
        i++;
      } else i = end;
    } else i = word(src, i, push);
  }
  return out;
}

/** Whether a `/` after `prev` starts a regular expression. */
const regexMayStart = (prev: Token | undefined): boolean =>
  prev === undefined ||
  ((prev.type === 'punct' || prev.type === 'id') &&
    REGEX_AFTER.has(prev.value));

/** An identifier, a number or one punctuation code point at `i`; returns the index after it. */
function word(
  src: string,
  i: number,
  push: (type: Token['type'], value: string) => void,
): number {
  ID.lastIndex = i;
  const id = ID.exec(src);
  if (id !== null) {
    push('id', id[0]);
    return ID.lastIndex;
  }
  NUM.lastIndex = i;
  const num = NUM.exec(src);
  if (num !== null) {
    push('num', num[0]);
    return NUM.lastIndex;
  }
  const ch = String.fromCodePoint(src.codePointAt(i) ?? 0);
  push('punct', ch);
  return i + ch.length;
}
