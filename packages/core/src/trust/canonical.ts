import { TrustError } from './errors.js';

/** A lone UTF-16 surrogate: it has no UTF-8 form, so it would collide with U+FFFD when encoded. */
const LONE_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/**
 * Canonical JSON of ADR 0025 Amendment 2026-11-02 section 5: keys sorted bytewise at every depth, no
 * whitespace, UTF-8. Signatures and digests are computed over these bytes, so two writers that hold the
 * same value always sign the same text, and two different values never produce the same text.
 *
 * @remarks Keys are compared by their UTF-8 bytes, not by UTF-16 code units, so a key outside the BMP sorts
 *   the same way in every implementation. `undefined` object members are dropped, as `JSON.stringify` does.
 * @throws {TrustError} `trust_entry_invalid` for a value with no exact JSON form: a non-finite number,
 *   `-0`, a string or key with a lone surrogate, a sparse array, an object that is not a plain object
 *   (a `Date`, a `Map`, a class instance), a bigint, a function, a symbol, or `undefined` outside an
 *   object member.
 * @example canonicalJson({ b: 1, a: [2, { y: 1, x: 0 }] }) === '{"a":[2,{"x":0,"y":1}],"b":1}'
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'string') return string(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw unrepresentable('a non-finite number');
    if (Object.is(value, -0)) throw unrepresentable('-0');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw unrepresentable('a sparse array');
      items.push(canonicalJson(value[i]));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null)
      throw unrepresentable('an object that is not a plain object');
    const members = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    return `{${members.map(([k, v]) => `${string(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw unrepresentable(typeof value);
}

function string(s: string): string {
  if (LONE_SURROGATE.test(s)) throw unrepresentable('a lone surrogate');
  return JSON.stringify(s);
}

const unrepresentable = (what: string): TrustError =>
  new TrustError(
    'trust_entry_invalid',
    `A trust value contains ${what}, which has no canonical JSON form; store only JSON data.`,
  );
