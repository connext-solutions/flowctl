import type { SchemaObject } from './js-chain.js';
import type { JsToken } from './js-lex.js';
import { canonicalNumber } from './numbers.js';

/** An argument of a call in a schema chain: a literal, a nested object schema, or `other` (not a literal). */
export type Arg =
  | { kind: 'str'; value: string }
  | { kind: 'num'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'regex'; value: string }
  | { kind: 'list'; items: readonly string[] }
  | { kind: 'object'; props: ReadonlyMap<string, Arg> }
  | { kind: 'schema'; schema: SchemaObject }
  | { kind: 'other' };

/** Whether `t` is the punctuation `v` (a string token that reads `{` is not). */
export const isP = (t: JsToken | undefined, v: string): boolean =>
  t?.type === 'punct' && t.value === v;

export function literal(t: JsToken): Arg {
  if (t.type === 'str') return { kind: 'str', value: t.value };
  if (t.type === 'regex') return { kind: 'regex', value: t.value };
  if (t.type === 'num') {
    const n = canonicalNumber(t.value, 'js');
    return n === undefined ? { kind: 'other' } : { kind: 'num', value: n };
  }
  if (t.type === 'id' && (t.value === 'true' || t.value === 'false'))
    return { kind: 'bool', value: t.value === 'true' };
  return { kind: 'other' };
}

export function list(t: readonly JsToken[]): Arg {
  const items: string[] = [];
  for (let i = 1; i < t.length - 1; i += 2) {
    const v = t[i];
    const a = v === undefined ? undefined : literal(v);
    if (
      (a?.kind !== 'str' && a?.kind !== 'num') ||
      (i + 1 < t.length - 1 && !isP(t[i + 1], ','))
    )
      return { kind: 'other' };
    items.push(a.value);
  }
  return { kind: 'list', items };
}

export function objectArg(t: readonly JsToken[]): Arg {
  const props = new Map<string, Arg>();
  for (let i = 1; i < t.length - 1; i += 4) {
    const k = t[i];
    const v = t[i + 2];
    if (
      (k?.type !== 'id' && k?.type !== 'str') ||
      !isP(t[i + 1], ':') ||
      v === undefined ||
      (i + 3 < t.length - 1 && !isP(t[i + 3], ','))
    )
      return { kind: 'other' };
    props.set(k.value, literal(v));
  }
  return { kind: 'object', props };
}
