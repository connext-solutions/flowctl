// dup-ok: derive sits below reconcile in CORE_LAYERS and may not import its lexer; this is a trimmed copy (ADR 0040)
import { ContractParseError } from './safe-data.js';
import { scanQuoted, scanRegex, scanTemplate } from './js-literals.js';

/**
 * A token of JavaScript-like source: an identifier, a string literal with its escapes decoded, a number as written,
 * a regular expression literal (its body), a template literal with a substitution (`tmpl`, its text unknown) or one
 * punctuation character. `line` is 1-based.
 */
export interface JsToken {
  type: 'id' | 'str' | 'num' | 'regex' | 'tmpl' | 'punct';
  value: string;
  line: number;
}

const ID = /[\p{ID_Start}$_][\p{ID_Continue}$‌‍]*/uy;
const NUM =
  /(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|\.\d+)n?/y;
const SPACE = /[ \t\r\f\v ﻿]+/y;
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
 * Splits JavaScript, TypeScript or JSX source into {@link JsToken}s in one linear pass, skipping comments and
 * whitespace. It is not a parser and never evaluates anything: a stray or unclosed quote becomes a punctuation
 * token, an unclosed template or comment ends at the end of the text, and a regular expression is kept as text.
 *
 * @throws {ContractParseError} `too_many_tokens` past `maxTokens`.
 */
export function lexJs(src: string, maxTokens: number): JsToken[] {
  const out: JsToken[] = [];
  const unclosed = new Map<string, number>();
  let line = 1;
  let i = 0;
  const push = (type: JsToken['type'], value: string, at = line): void => {
    if (out.length >= maxTokens)
      throw new ContractParseError('too_many_tokens');
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
      const s = known(c) ? undefined : scanQuoted(src, i);
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
      const t = scanTemplate(src, i);
      push(t.value === null ? 'tmpl' : 'str', t.value ?? '');
      line += t.lines;
      i = t.end;
    } else if (c === '/' && regexMayStart(out.at(-1))) {
      const r = known(c) ? undefined : scanRegex(src, i);
      if (r === undefined || 'stop' in r) {
        if (r !== undefined) unclosed.set(c, r.stop);
        push('punct', c);
        i++;
      } else {
        push('regex', r.body);
        i = r.end;
      }
    } else i = word(src, i, push);
  }
  return out;
}

const regexMayStart = (prev: JsToken | undefined): boolean =>
  prev === undefined ||
  ((prev.type === 'punct' || prev.type === 'id') &&
    REGEX_AFTER.has(prev.value));

function word(
  src: string,
  i: number,
  push: (type: JsToken['type'], value: string) => void,
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
