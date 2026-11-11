import { describe, expect, it } from 'vitest';
import { canonicalJson, TrustError } from '../src/trust/index.js';

/**
 * Canonical JSON of ADR 0025 Amendment 2026-11-02 section 5: what owner signatures and digests cover, so
 * one value must give exactly one byte string and two values never the same one.
 */
describe('canonical JSON', () => {
  it('sorts keys bytewise at every depth and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: 'é' } })).toBe(
      '{"a":{"c":"é","d":[2,{"x":0,"y":1}]},"b":1}',
    );
  });

  it('sorts by UTF-8 bytes, not UTF-16 code units', () => {
    // UTF-8: U+FF61 (ef bd a1) < U+1F600 (f0 9f 98 80); UTF-16 would put the emoji first.
    expect(canonicalJson({ '\u{1F600}': 1, '\uFF61': 2 })).toBe(
      '{"\uFF61":2,"\u{1F600}":1}',
    );
  });

  const sparse: unknown[] = [];
  sparse[2] = 3;

  it.each([
    ['a non-finite number', { a: Number.NaN }],
    ['-0', { a: -0 }],
    ['a lone surrogate in a value', { a: '\uD800' }],
    ['a lone surrogate in a key', { '\uDC00': 1 }],
    ['a sparse array', { a: sparse }],
    ['a Date', { a: new Date(0) }],
    ['a Map', { a: new Map() }],
  ])('refuses %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(TrustError);
  });
});
