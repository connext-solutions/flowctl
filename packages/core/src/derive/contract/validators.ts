import { type Emitter, pointerOf } from './emit.js';
import type { Arg, Call, Chain, SchemaObject } from './js-chain.js';
import type { ContractRule } from './types.js';

/** A rule read from a chain: what it states, its literal value and the message that goes with it. */
export interface ChainRule {
  rule: ContractRule;
  value: string;
  messageKey?: string;
  line: number;
}

/** Turns a chain into rules; `skip` reports a method or argument it does not read, with the line. */
export type ChainReader = (
  chain: Chain,
  skip: (reason: string, line: number) => void,
) => ChainRule[];

/** The sorted, de-duplicated values of an enum as the JSON array text a fact carries. */
export const enumValue = (items: readonly string[]): string =>
  JSON.stringify([...new Set(items)].sort());

/** The argument at `i` when it is a literal of `kind`. */
export function argOf<K extends Arg['kind']>(
  call: Call,
  i: number,
  kind: K,
): Extract<Arg, { kind: K }> | undefined {
  const a = call.args[i];
  return a?.kind === kind ? (a as Extract<Arg, { kind: K }>) : undefined;
}

/** A message given as a string argument at `i`, or as `{ message: '...' }`. */
export function messageAt(call: Call, i: number): string | undefined {
  const a = call.args[i];
  if (a?.kind === 'str') return a.value;
  const m = a?.kind === 'object' ? a.props.get('message') : undefined;
  return m?.kind === 'str' ? m.value : undefined;
}

/**
 * Emits the facts of every entry of `schema` that `read` understands: field `prefix + key`, pointer
 * `/<owner>/<field path>/<rule>` (the owner is the variable the top schema is assigned to, or `schemaN`, and
 * stays the owner of every schema nested in it). A rule a chain repeats (`.min(1).min(2)`) keeps its place in the
 * pointer (`minLength`, then `minLength.2`), so every pointer is unique. A nested object schema is read with the
 * key as prefix. Entries and methods that cannot be read are skips with their line.
 */
export function emitSchema(
  schema: SchemaObject,
  out: Emitter,
  read: ChainReader,
  path: readonly string[] = [],
  owner: string = schema.owner,
): void {
  for (const e of schema.entries) {
    if (e.chain === undefined) {
      out.skip(e.reason ?? 'unsupported_entry', e.line);
      continue;
    }
    const at = [...path, e.key];
    for (const call of e.chain.calls)
      for (const a of call.args)
        if (a.kind === 'schema') emitSchema(a.schema, out, read, at, owner);
    const times = new Map<string, number>();
    for (const r of read(e.chain, (reason, line) => out.skip(reason, line))) {
      const nth = (times.get(r.rule) ?? 0) + 1;
      times.set(r.rule, nth);
      const f = {
        line: r.line,
        pointer: pointerOf([
          owner,
          ...at,
          nth === 1 ? r.rule : `${r.rule}.${nth}`,
        ]),
        owner,
        field: at.join('.'),
        rule: r.rule,
        value: r.value,
      };
      out.fact(
        r.messageKey === undefined ? f : { ...f, messageKey: r.messageKey },
      );
    }
  }
}
