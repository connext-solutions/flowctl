import { type Arg, isP, list, literal, objectArg } from './js-args.js';
import { canonicalNumber } from './numbers.js';
import type { JsToken } from './js-lex.js';
import { ContractParseError } from './safe-data.js';

export type { Arg } from './js-args.js';

/** One `.name(args)` of a chain; `line` is where the name is. */
export interface Call {
  name: string;
  args: readonly Arg[];
  line: number;
}

/** A chain such as `z.string().min(1)`, without its namespace. */
export interface Chain {
  calls: readonly Call[];
}

/** One key of a schema object: its chain, or `reason` when the entry is not a literal chain. */
export interface Entry {
  key: string;
  line: number;
  chain?: Chain;
  reason?: string;
}

/** A `z.object({...})` or `Joi.object({...})` literal: its variable name (or `schemaN`) and its keys. */
export interface SchemaObject {
  owner: string;
  line: number;
  entries: readonly Entry[];
}

/** The schemas found in a token stream, and the places the scan gave up. */
export interface Found {
  schemas: SchemaObject[];
  skips: { line: number; reason: string }[];
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

/**
 * Finds the schema objects of a token stream by shape only: `ns.object({ key: ns.method(literal).method(...) })`
 * with the namespace `ns` one of `namespaces` (`z`, `Joi`). Nothing is evaluated or resolved: a key whose value
 * is not a literal chain (a variable, a spread, a computed key, an imported schema) is an entry with a `reason`,
 * and a call argument that is not a literal is `other`. Brackets are tracked with a counter capped at
 * `maxDepth`; past it the scan stops with one skip, so a hostile nesting costs a bounded amount of work.
 *
 * @see docs/adr/0040-contract-readers.md
 */
export function findSchemas(
  tokens: readonly JsToken[],
  namespaces: ReadonlySet<string>,
  maxDepth: number,
): Found {
  const found: Found = { schemas: [], skips: [] };
  const p = new Parser(tokens, namespaces, maxDepth);
  try {
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (
        t?.type !== 'id' ||
        !namespaces.has(t.value) ||
        isP(tokens[i - 1], '.') ||
        !isP(tokens[i + 1], '.') ||
        tokens[i + 2]?.value !== 'object' ||
        !isP(tokens[i + 3], '(') ||
        !isP(tokens[i + 4], '{')
      )
        continue;
      const owner = ownerOf(tokens, i, found.schemas.length);
      const { schema, next } = p.object(i + 4, owner, 0);
      found.schemas.push(schema);
      i = next;
    }
  } catch (e) {
    if (!(e instanceof ContractParseError)) throw e;
    found.skips.push({ line: p.line, reason: e.reason });
  }
  return found;
}

/** The variable a schema is assigned to (`const x = z.object(`), else `schemaN`. */
function ownerOf(tokens: readonly JsToken[], i: number, n: number): string {
  const name = tokens[i - 2];
  return isP(tokens[i - 1], '=') && name?.type === 'id'
    ? name.value
    : `schema${n}`;
}

class Parser {
  line = 0;

  constructor(
    private readonly t: readonly JsToken[],
    private readonly ns: ReadonlySet<string>,
    private readonly maxDepth: number,
  ) {}

  /** The schema whose `{` is at `open`, and the index of its closing `}`. */
  object(
    open: number,
    owner: string,
    depth: number,
  ): { schema: SchemaObject; next: number } {
    this.check(depth, open);
    const entries: Entry[] = [];
    let i = open + 1;
    while (i < this.t.length && !isP(this.t[i], '}')) {
      if (isP(this.t[i], ',')) {
        i++;
        continue;
      }
      const key = this.t[i];
      const start = i;
      if (
        (key?.type === 'id' || key?.type === 'str') &&
        isP(this.t[i + 1], ':')
      ) {
        const chain = this.chain(i + 2, depth);
        if (chain === undefined) {
          entries.push({
            key: key.value,
            line: key.line,
            reason: 'not_a_literal_schema',
          });
          i = this.skipEntry(i + 2, depth);
        } else {
          entries.push({ key: key.value, line: key.line, chain: chain.chain });
          i = chain.next;
        }
      } else {
        entries.push({
          key: '',
          line: this.t[start]?.line ?? 0,
          reason: isP(key, '.') ? 'spread' : 'unsupported_entry',
        });
        i = this.skipEntry(i, depth);
      }
    }
    return {
      schema: { owner, line: this.t[open]?.line ?? 0, entries },
      next: i,
    };
  }

  /** The chain at `i` and the index after it, or `undefined` when the value is not `ns.method(...)...`. */
  private chain(
    start: number,
    depth: number,
  ): { chain: Chain; next: number } | undefined {
    const head = this.t[start];
    if (head?.type !== 'id' || !this.ns.has(head.value)) return undefined;
    const calls: Call[] = [];
    let i = start + 1;
    while (isP(this.t[i], '.') && this.t[i + 1]?.type === 'id') {
      const name = this.t[i + 1];
      const line = name?.line ?? 0;
      i += 2;
      let args: Arg[] = [];
      if (isP(this.t[i], '(')) {
        const r = this.args(i, name?.value ?? '', depth);
        args = r.args;
        i = r.next;
      }
      calls.push({ name: name?.value ?? '', args, line });
    }
    const end = this.t[i];
    return end === undefined || isP(end, ',') || isP(end, '}')
      ? { chain: { calls }, next: i }
      : undefined;
  }

  /** The arguments of the call whose `(` is at `open`, and the index after its `)`. */
  private args(
    open: number,
    method: string,
    depth: number,
  ): { args: Arg[]; next: number } {
    const args: Arg[] = [];
    let i = open + 1;
    let from = i;
    let level = 0;
    const flush = (to: number): void => {
      if (to > from) args.push(this.arg(from, to, method, depth));
    };
    for (; i < this.t.length; i++) {
      const v = this.t[i]?.type === 'punct' ? (this.t[i]?.value ?? '') : '';
      if (OPEN.has(v)) this.check(depth + ++level, i);
      else if (CLOSE.has(v)) {
        if (level === 0) {
          flush(i);
          return { args, next: i + 1 };
        }
        level--;
      } else if (v === ',' && level === 0) {
        flush(i);
        from = i + 1;
      }
    }
    flush(i);
    return { args, next: i };
  }

  private arg(from: number, to: number, method: string, depth: number): Arg {
    const t = this.t.slice(from, to);
    const first = t[0];
    if (t.length === 1 && first !== undefined) return literal(first);
    if (t.length === 2 && isP(first, '-') && t[1]?.type === 'num') {
      const n = canonicalNumber(t[1].value, 'js');
      return n === undefined
        ? { kind: 'other' }
        : { kind: 'num', value: n === '0' ? '0' : `-${n}` };
    }
    if (isP(first, '[') && isP(t.at(-1), ']')) return list(t);
    if (isP(first, '{') && isP(t.at(-1), '}'))
      return method === 'object' || method === 'keys' || method === 'shape'
        ? {
            kind: 'schema',
            schema: this.object(from, method, depth + 1).schema,
          }
        : objectArg(t);
    return { kind: 'other' };
  }

  /** The index after an entry that cannot be read: its next top-level comma, or the closing `}`. */
  private skipEntry(from: number, depth: number): number {
    let level = 0;
    for (let i = from; i < this.t.length; i++) {
      const v = this.t[i]?.type === 'punct' ? (this.t[i]?.value ?? '') : '';
      if (OPEN.has(v)) this.check(depth + ++level, i);
      else if (CLOSE.has(v)) {
        if (level === 0) return i;
        level--;
      } else if (v === ',' && level === 0) return i;
    }
    return this.t.length;
  }

  private check(depth: number, at: number): void {
    this.line = this.t[at]?.line ?? this.line;
    if (depth > this.maxDepth) throw new ContractParseError('too_deep');
  }
}
