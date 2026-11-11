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

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/** One escape after a backslash at `i`: its text and the index after it. */
function escapeAt(src: string, i: number): [string, number] {
  const c = src[i + 1] ?? '';
  if (c === 'u' && src[i + 2] === '{') {
    const end = src.indexOf('}', i + 3);
    const cp = end < 0 ? NaN : Number.parseInt(src.slice(i + 3, end), 16);
    return Number.isInteger(cp) && cp <= 0x10ffff
      ? [String.fromCodePoint(cp), end + 1]
      : ['', i + 2];
  }
  if (c === 'u' || c === 'x') {
    const len = c === 'u' ? 4 : 2;
    const hex = src.slice(i + 2, i + 2 + len);
    return /^[\da-fA-F]+$/.test(hex) && hex.length === len
      ? [String.fromCharCode(Number.parseInt(hex, 16)), i + 2 + len]
      : ['', i + 2];
  }
  if (c === '\r' && src[i + 2] === '\n') return ['', i + 3];
  if (c === '\n' || c === '\r' || c === '\u2028' || c === '\u2029')
    return ['', i + 2];
  return [ESCAPES[c] ?? c, i + 2];
}

/** A quoted string from `i`; `undefined` when a line ends first (a stray quote in JSX text, say). */
function quoted(
  src: string,
  i: number,
): { value: string; end: number; lines: number } | undefined {
  const q = src[i];
  let out = '';
  let lines = 0;
  for (let j = i + 1; j < src.length;) {
    const c = src[j];
    if (c === q) return { value: out, end: j + 1, lines };
    if (c === '\n') return undefined;
    if (c === '\\') {
      if (src[j + 1] === '\n') lines++;
      const [text, next] = escapeAt(src, j);
      out += text;
      j = next;
    } else {
      out += c;
      j++;
    }
  }
  return undefined;
}

/**
 * A template literal from `i`: its text when it has no substitution, `null` when it has one. Substitutions are
 * skipped by brace depth only, which is linear and good enough for an index.
 */
function template(
  src: string,
  i: number,
): { value: string | null; end: number; lines: number } {
  let out: string | null = '';
  let lines = 0;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '`') return { value: out, end: j + 1, lines };
    if (c === '\n') lines++;
    if (c === '\\') {
      const [text, next] = escapeAt(src, j);
      if (src[j + 1] === '\n') lines++;
      if (out !== null) out += text;
      j = next;
    } else if (c === '$' && src[j + 1] === '{') {
      out = null;
      let depth = 1;
      for (j += 2; j < src.length && depth > 0; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}') depth--;
        else if (src[j] === '\n') lines++;
      }
    } else {
      if (out !== null) out += c;
      j++;
    }
  }
  return { value: out, end: j, lines };
}

/** The end of a regular expression literal from `i`, or `undefined` when the line ends first. */
function regexEnd(src: string, i: number): number | undefined {
  let inClass = false;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j];
    if (c === '\n') return undefined;
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k] ?? '')) k++;
      return k;
    }
  }
  return undefined;
}

/**
 * Splits JavaScript, TypeScript or JSX source into {@link Token}s, skipping comments, whitespace and regular
 * expressions, in one linear pass.
 *
 * @remarks Not a parser: JSX text is read as code. A stray quote in JSX text (`Don't`) whose line ends before a
 *   closing quote becomes a punctuation token and the lexer goes on after it, so the damage stays on that line.
 *   A `/` after `<`, `>`, `)`, `]` or `}` is a division, so `</Route>` and `{x} />` lex as punctuation.
 */
export function lex(src: string): Token[] {
  const out: Token[] = [];
  let line = 1;
  let i = 0;
  const push = (type: Token['type'], value: string, at = line): void => {
    out.push({ type, value, line: at });
  };
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
      const s = quoted(src, i);
      if (s === undefined) {
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
      const end = regexEnd(src, i);
      if (end === undefined) {
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
