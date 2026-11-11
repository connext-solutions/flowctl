/**
 * Strict reading of a request body for the destructive request layer (ADR 0024 section 5, ledger rule 4, and its
 * amendment 2026-11-12 "destructive ledger details", section 2): a BOM, bytes that are not UTF-8, duplicate JSON keys
 * at any depth, a member named `*` and an unsupported content type each block the request. Pure functions.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */

/** One leaf of a body: its JSON Pointer with array indices, the same with each index as `*`, and its value. */
export interface Leaf {
  pointer: string;
  general: string;
  value: unknown;
}

/** The deepest a body may nest; deeper bodies are refused rather than walked. */
const MAX_DEPTH = 64;

/** The content types an entry may name, as the header must spell them (an optional `charset=utf-8` only). */
const TYPES = {
  json: /^application\/json(\s*;\s*charset="?utf-8"?)?$/i,
  urlencoded:
    /^application\/x-www-form-urlencoded(\s*;\s*charset="?utf-8"?)?$/i,
} as const;

/** The pointer segment of a key, escaped as RFC 6901 says. */
export const escapeSegment = (k: string): string =>
  k.replace(/~/g, '~0').replace(/\//g, '~1');

class Parser {
  private at = 0;
  constructor(private readonly s: string) {}

  /** @throws {Error} with the problem as its message. */
  parse(): unknown {
    const v = this.value(0);
    this.ws();
    if (this.at !== this.s.length) throw new Error('text after the JSON value');
    return v;
  }

  private ws(): void {
    while (/[ \t\n\r]/.test(this.s[this.at] ?? '')) this.at++;
  }

  private value(depth: number): unknown {
    if (depth > MAX_DEPTH) throw new Error(`nested deeper than ${MAX_DEPTH}`);
    this.ws();
    const c = this.s[this.at];
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"') return this.string();
    const m =
      /^(?:-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?|true|false|null)/.exec(
        this.s.slice(this.at, this.at + 400),
      );
    if (m === null) throw new Error(`bad JSON at character ${this.at}`);
    this.at += m[0].length;
    const parsed: unknown = JSON.parse(m[0]);
    return parsed;
  }

  private string(): string {
    const start = this.at;
    this.at++;
    for (;;) {
      const c = this.s[this.at];
      if (c === undefined) throw new Error('an unterminated string');
      if (c === '\\') this.at += 2;
      else if (c === '"') break;
      else this.at++;
    }
    this.at++;
    const parsed: unknown = JSON.parse(this.s.slice(start, this.at));
    if (typeof parsed !== 'string') throw new Error('bad string');
    return parsed;
  }

  private object(depth: number): Record<string, unknown> {
    this.at++;
    const out: Record<string, unknown> = {};
    const keys = new Set<string>();
    this.ws();
    if (this.s[this.at] === '}') {
      this.at++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.at] !== '"')
        throw new Error('an object key is not a string');
      const k = this.string();
      if (keys.has(k))
        throw new Error(`the key "${k.slice(0, 40)}" appears twice`);
      keys.add(k);
      this.ws();
      if (this.s[this.at] !== ':') throw new Error('a key without ":"');
      this.at++;
      Object.defineProperty(out, k, {
        value: this.value(depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      this.ws();
      const c = this.s[this.at++];
      if (c === '}') return out;
      if (c !== ',') throw new Error('an object without "," or "}"');
    }
  }

  private array(depth: number): unknown[] {
    this.at++;
    const out: unknown[] = [];
    this.ws();
    if (this.s[this.at] === ']') {
      this.at++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      this.ws();
      const c = this.s[this.at++];
      if (c === ']') return out;
      if (c !== ',') throw new Error('an array without "," or "]"');
    }
  }
}

/**
 * Parses JSON text strictly: duplicate keys at any depth, nesting deeper than 64 and trailing text are refused.
 *
 * @returns the value, or the problem as a sentence.
 */
export function parseStrictJson(text: string): { value: unknown } | string {
  try {
    return { value: new Parser(text).parse() };
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Every leaf of `value` with its pointers (see {@link Leaf}); a member named `*` is the problem returned. */
export function leavesOf(value: unknown): Leaf[] | string {
  const out: Leaf[] = [];
  const walk = (v: unknown, p: string, g: string): string | undefined => {
    if (Array.isArray(v) && v.length > 0) {
      for (const [i, x] of v.entries()) {
        const bad = walk(x, `${p}/${i}`, `${g}/*`);
        if (bad !== undefined) return bad;
      }
      return undefined;
    }
    if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
      const entries = Object.entries(v);
      if (entries.length > 0) {
        for (const [k, x] of entries) {
          if (k === '*') return 'a body member is named "*"';
          const bad = walk(
            x,
            `${p}/${escapeSegment(k)}`,
            `${g}/${escapeSegment(k)}`,
          );
          if (bad !== undefined) return bad;
        }
        return undefined;
      }
    }
    out.push({ pointer: p, general: g, value: v });
    return undefined;
  };
  const bad = walk(value, '', '');
  return bad ?? out;
}

/**
 * The leaves of a request body sent as `contentType` with the header `header`.
 *
 * @param body the raw bytes; `null` or empty for no body, which has no leaves.
 * @param contentType the entry's `contentType`; `undefined` admits only a request without a body.
 * @returns the leaves, or why the body blocks the request.
 */
export function readBody(
  body: Buffer | null,
  header: string | undefined,
  contentType: 'json' | 'urlencoded' | undefined,
): Leaf[] | string {
  if (body === null || body.length === 0)
    return header === undefined || contentType !== undefined
      ? []
      : 'a Content-Type without a body';
  if (contentType === undefined) return 'a body the entry does not admit';
  if (header === undefined) return 'a body without a Content-Type';
  if (!TYPES[contentType].test(header.trim()))
    return `the Content-Type "${header.slice(0, 60)}" is not the entry's ${contentType}`;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf)
    return 'a body that starts with a BOM';
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return 'a body that is not UTF-8';
  }
  if (contentType === 'json') {
    const parsed = parseStrictJson(text);
    return typeof parsed === 'string'
      ? `the JSON body: ${parsed}`
      : leavesOf(parsed.value);
  }
  const out: Leaf[] = [];
  const names = new Set<string>();
  for (const part of text.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    let name: string;
    let value: string;
    try {
      name = decodeURIComponent(
        (eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '),
      );
      value = decodeURIComponent(
        (eq < 0 ? '' : part.slice(eq + 1)).replace(/\+/g, ' '),
      );
    } catch {
      return 'a form field with a malformed escape';
    }
    if (names.has(name))
      return `the form field "${name.slice(0, 40)}" appears twice`;
    if (name === '*') return 'a form field is named "*"';
    names.add(name);
    const pointer = `/${escapeSegment(name)}`;
    out.push({ pointer, general: pointer, value });
  }
  return out;
}
