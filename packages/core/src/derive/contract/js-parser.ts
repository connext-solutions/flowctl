import { type Arg, isP, list, literal, objectArg } from './js-args.js';
import type { Call, Chain, Entry, SchemaObject } from './js-chain.js';
import type { JsToken } from './js-lex.js';
import { canonicalNumber } from './numbers.js';
import { ContractParseError } from './safe-data.js';

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);
const SCHEMA_METHODS = new Set(['object', 'keys', 'shape', 'extend']);
const EXTENDERS = new Set(['extend', 'keys', 'merge', 'augment']);

/** The recognizer of the shape `ns.object({ key: ns.method(literal)... })` over a token stream (see `findSchemas`). */
export class Parser {
  line = 0;
  readonly skips: { line: number; reason: string }[] = [];

  constructor(
    private readonly t: readonly JsToken[],
    private readonly ns: ReadonlySet<string>,
    private readonly maxDepth: number,
    private readonly maxKeys: number,
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
      if (entries.length >= this.maxKeys)
        throw new ContractParseError('too_many_keys');
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

  /**
   * The calls that follow a schema object whose `)` is at `from - 1`: `.extend({...})` and `.keys({...})` add their
   * entries to the schema; `.merge(...)`, `.augment(...)` or a non-literal argument is a skip with its line, never
   * silent. Any other call is passed over. Returns the extended schema and the index of its last token.
   */
  extensions(
    from: number,
    schema: SchemaObject,
  ): { schema: SchemaObject; next: number } {
    const entries: Entry[] = [...schema.entries];
    let i = from;
    while (isP(this.t[i], '.') && this.t[i + 1]?.type === 'id') {
      const name = this.t[i + 1]?.value ?? '';
      const line = this.t[i + 1]?.line ?? 0;
      if (!isP(this.t[i + 2], '(')) break;
      if (EXTENDERS.has(name)) {
        const r = this.args(i + 2, name, 0);
        const arg = r.args[0];
        if (arg?.kind === 'schema') {
          for (const e of arg.schema.entries) entries.push(e);
          if (entries.length > this.maxKeys)
            throw new ContractParseError('too_many_keys');
        } else this.skips.push({ line, reason: 'schema_extension_unread' });
        i = r.next;
      } else i = this.afterCall(i + 2);
    }
    return { schema: { ...schema, entries }, next: i - 1 };
  }

  /** The arguments of the call whose `(` is at `open`, and the index after its `)`. */
  args(
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
    if (isP(first, '[') && isP(t.at(-1), ']')) {
      const items = list(t);
      if (items.kind !== 'other') return items;
    }
    if (isP(first, '{') && isP(t.at(-1), '}'))
      return SCHEMA_METHODS.has(method)
        ? {
            kind: 'schema',
            schema: this.object(from, method, depth + 1).schema,
          }
        : objectArg(t);
    const nested = this.nestedAt(t);
    if (nested === 0)
      return {
        kind: 'schema',
        schema: this.object(from + 4, method, depth + 1).schema,
      };
    if (nested > 0)
      this.skips.push({
        line: first?.line ?? 0,
        reason: 'nested_schema_unread',
      });
    return { kind: 'other' };
  }

  /** The index after the `)` that closes the `(` at `open`. */
  private afterCall(open: number): number {
    let level = 0;
    for (let i = open; i < this.t.length; i++) {
      const v = this.t[i]?.type === 'punct' ? (this.t[i]?.value ?? '') : '';
      if (OPEN.has(v)) this.check(++level, i);
      else if (CLOSE.has(v) && --level === 0) return i + 1;
    }
    return this.t.length;
  }

  /** The offset in `t` of the first `ns.object({`, or -1: a schema an argument holds (`z.array(z.object({...}))`). */
  private nestedAt(t: readonly JsToken[]): number {
    for (let k = 0; k + 4 < t.length; k++) {
      const head = t[k];
      if (
        head?.type === 'id' &&
        this.ns.has(head.value) &&
        isP(t[k + 1], '.') &&
        t[k + 2]?.value === 'object' &&
        isP(t[k + 3], '(') &&
        isP(t[k + 4], '{')
      )
        return k;
    }
    return -1;
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
