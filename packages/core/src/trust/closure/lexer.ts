import type { QuoteState, ShellWord } from './types.js';

/** A lexer token: a word, a control operator, a file redirection operator or an fd duplication. */
export type LexToken =
  | { t: 'word'; word: ShellWord; line: number }
  | { t: 'op'; op: ';' | '&&' | '||' | '|' | 'NL'; line: number }
  | { t: 'redir'; op: '<' | '>' | '>>'; line: number }
  | { t: 'dup'; line: number };

interface Builder {
  chars: { c: string; s: QuoteState }[];
  raw: string;
}

const BOUNDARY = ' \t\n;&|<>()';
const DUPS = new Set(['2>&1', '1>&2', '>&2']);
const DECODER = new TextDecoder('utf-8', { fatal: true });
/**
 * Under a Big5, SJIS or GBK locale, bash 3.2 (macOS `/bin/sh`) reads a lead byte plus the next byte as one
 * character, and the next byte may be any of 0x40-0x7E. A UTF-8 character ends in a byte 0x80-0xBF that
 * such a locale can read as a lead byte, so an ASCII byte right after it can vanish into it: `\` and `|`
 * change how the line parses (`rm -f ./.hook-tmp/Á|cat ./x` is one `rm` to bash). The non-letter bytes of
 * that range are refused there, outside single quotes and comments; letters and digits are harmless.
 */
const MULTIBYTE_TRAIL = 'shell metacharacter after a non-ASCII character';
const TRAIL_BYTES = '@[\\]^_`{|}~';

/** Whether `src[i]` is a byte a multibyte locale could merge into the non-ASCII character before it. */
const swallowable = (src: string, i: number): boolean =>
  i > 0 && src.charCodeAt(i - 1) > 0x7f && TRAIL_BYTES.includes(src.charAt(i));
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * True when `bytes` may be tokenised and shown: valid UTF-8 with no NUL, no byte below 0x20 other than LF
 * and TAB, and no 0x7f (ADR 0021 Amendment 2026-11-02 section 1, "Input bytes"). Checked on raw bytes,
 * before tokenising, because a shell may drop a NUL while reading.
 */
export function bytesAllowed(bytes: Uint8Array): boolean {
  for (const b of bytes)
    if (b === 0x7f || (b < 0x20 && b !== 0x0a && b !== 0x09)) return false;
  try {
    DECODER.decode(bytes);
    return true;
  } catch {
    return false;
  }
}

/** True when `text` (hook text from a flow) passes the same check, lone surrogates included. */
export const textAllowed = (text: string): boolean =>
  !LONE_SURROGATE.test(text) && bytesAllowed(Buffer.from(text));

/**
 * Splits shell text into tokens without executing or expanding anything (ADR 0021 Amendment 2026-11-02
 * section 1).
 *
 * @remarks A comment starts only at an unquoted `#` that begins a word and ends at the first newline,
 *   backslash or not. Backslash-newline is deleted outside single quotes and comments. A digit word directly
 *   before `<` or `>` is an fd prefix; only 0, 1 and 2 are allowed. Each character keeps its quote state.
 * @returns the tokens, or a description of the first operator or quote the subset does not accept.
 */
export function tokenize(src: string): LexToken[] | string {
  const tokens: LexToken[] = [];
  let w: Builder | undefined;
  let line = 1;
  let i = 0;
  const word = (): Builder => (w ??= { chars: [], raw: '' });
  const flush = (): void => {
    if (w === undefined) return;
    const text = w.chars.map((x) => x.c).join('');
    tokens.push({ t: 'word', word: { ...w, text, pos: tokens.length }, line });
    w = undefined;
  };
  while (i < src.length) {
    const ch = src.charAt(i);
    const two = src.slice(i, i + 2);
    if (swallowable(src, i)) return MULTIBYTE_TRAIL;
    if (ch === '\\') {
      const nx = src.charAt(i + 1);
      if (nx === '') return 'trailing backslash';
      i += 2;
      if (nx === '\n') line++;
      else {
        word().chars.push({ c: nx, s: 'E' });
        word().raw += `\\${nx}`;
      }
    } else if (ch === "'") {
      const end = src.indexOf("'", i + 1);
      if (end === -1) return 'unterminated single quote';
      for (const c of src.slice(i + 1, end)) word().chars.push({ c, s: 'S' });
      word().raw += src.slice(i, end + 1);
      line += newlines(src.slice(i, end));
      i = end + 1;
    } else if (ch === '"') {
      const j = doubleQuoted(src, i + 1, word());
      if (typeof j === 'string') return j;
      line += newlines(src.slice(i, j));
      i = j;
    } else if (ch === ' ' || ch === '\t') {
      flush();
      i++;
    } else if (ch === '#' && w === undefined) {
      const nl = src.indexOf('\n', i);
      i = nl === -1 ? src.length : nl;
    } else if (ch === '\n') {
      flush();
      tokens.push({ t: 'op', op: 'NL', line });
      line++;
      i++;
    } else if (two === '&&' || two === '||') {
      flush();
      tokens.push({ t: 'op', op: two, line });
      i += 2;
    } else if ((ch === ';' && two !== ';;') || (ch === '|' && two !== '|&')) {
      flush();
      tokens.push({ t: 'op', op: ch, line });
      i++;
    } else if (';&|()'.includes(ch)) {
      return `operator ${two.trim().length === 2 ? two : ch}`;
    } else if (ch === '<' || ch === '>') {
      let fd = '';
      if (w !== undefined) {
        const plain = w.raw === w.chars.map((x) => x.c).join('');
        if (plain && /^[0-9]+$/.test(w.raw)) {
          if (!['0', '1', '2'].includes(w.raw))
            return `redirection prefix ${w.raw}`;
          fd = w.raw;
          w = undefined;
        } else flush();
      }
      const step = redirection(src, i, fd, line, tokens);
      if (typeof step === 'string') return step;
      i += step;
    } else {
      word().chars.push({ c: ch, s: 'U' });
      word().raw += ch;
      i++;
    }
  }
  flush();
  return tokens;
}

/** Pushes the redirection starting at `src[i]`; returns how many characters it used, or a problem. */
function redirection(
  src: string,
  i: number,
  fd: string,
  line: number,
  tokens: LexToken[],
): number | string {
  const ch = src.charAt(i);
  const nx = src.charAt(i + 1);
  if (ch === '<') {
    if (nx === '<' || nx === '&' || nx === '>') return `operator <${nx}`;
    tokens.push({ t: 'redir', op: '<', line });
    return 1;
  }
  if (nx === '>') {
    tokens.push({ t: 'redir', op: '>>', line });
    return 2;
  }
  if (nx === '|') return 'operator >|';
  if (nx === '&') {
    const spelling = `${fd}>&${src.charAt(i + 2)}`;
    const after = src.charAt(i + 3);
    if (!DUPS.has(spelling) || (after !== '' && !BOUNDARY.includes(after)))
      return `duplication ${spelling}`;
    tokens.push({ t: 'dup', line });
    return 3;
  }
  tokens.push({ t: 'redir', op: '>', line });
  return 1;
}

/**
 * Reads a double-quoted run starting after the opening quote.
 *
 * @returns the index after the closing quote, or the problem.
 */
function doubleQuoted(src: string, start: number, w: Builder): number | string {
  let j = start;
  let raw = '"';
  for (;;) {
    const c = src.charAt(j);
    if (c === '') return 'unterminated double quote';
    if (c === '"') {
      w.raw += `${raw}"`;
      return j + 1;
    }
    const nx = src.charAt(j + 1);
    if (c === '\\' && nx === '') return 'unterminated double quote';
    if (swallowable(src, j)) return MULTIBYTE_TRAIL;
    if (c === '\\' && nx === '\n') {
      raw += '\\\n';
      j += 2;
    } else if (c === '\\' && '$`"\\'.includes(nx)) {
      w.chars.push({ c: nx, s: 'E' });
      raw += `\\${nx}`;
      j += 2;
    } else {
      w.chars.push({ c, s: 'D' });
      raw += c;
      j++;
    }
  }
}

const newlines = (s: string): number => s.split('\n').length - 1;
