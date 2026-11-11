/**
 * The literal scanners of the lexer: strings with their escapes decoded, template literals, regular expressions.
 * Each scans forward from its opening character only, so the lexer's single pass stays linear.
 */

const ESCAPES: Readonly<Record<string, string>> = {
  n: '\n',
  t: '\t',
  r: '\r',
  b: '\b',
  f: '\f',
  v: '\v',
  '0': '\0',
};

/** The hex digits and closing brace of a `\u{…}` escape: at most 8 digits, so a missing `}` costs a fixed scan. */
const CODE_POINT = /([\da-fA-F]{1,8})\}/y;

/** One escape after a backslash at `i`: its text and the index after it. */
function escapeAt(src: string, i: number): [string, number] {
  const c = src[i + 1] ?? '';
  if (c === 'u' && src[i + 2] === '{') {
    CODE_POINT.lastIndex = i + 3;
    const m = CODE_POINT.exec(src);
    const cp = Number.parseInt(m?.[1] ?? '', 16);
    return m !== null && cp <= 0x10ffff
      ? [String.fromCodePoint(cp), CODE_POINT.lastIndex]
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

/** A scan that found no end: where it stopped (the line break or the end of the source). */
export interface Unclosed {
  stop: number;
}

/** A quoted string from `i`, or where the scan stopped when a line ends first (a stray quote in JSX text, say). */
export function quoted(
  src: string,
  i: number,
): { value: string; end: number; lines: number } | Unclosed {
  const q = src[i];
  let out = '';
  let lines = 0;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === q) return { value: out, end: j + 1, lines };
    if (c === '\n') return { stop: j };
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
  return { stop: j };
}

/**
 * A template literal from `i`: its text when it has no substitution, `null` when it has one. Substitutions are
 * skipped by brace depth only, which is linear and good enough for an index; an unclosed template runs to the end
 * of the source, so it is never scanned twice.
 */
export function template(
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

/** The end of a regular expression literal from `i`, or where the scan stopped when the line ends first. */
export function regexEnd(src: string, i: number): number | Unclosed {
  let inClass = false;
  let j = i + 1;
  for (; j < src.length; j++) {
    const c = src[j];
    if (c === '\n') return { stop: j };
    if (c === '\\') j++;
    else if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) {
      let k = j + 1;
      while (k < src.length && /[a-z]/i.test(src[k] ?? '')) k++;
      return k;
    }
  }
  return { stop: j };
}
