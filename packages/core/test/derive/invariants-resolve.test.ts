import { describe, expect, it } from 'vitest';
import {
  expandInvariant,
  invariantResolves,
  type InvariantId,
} from '../../src/derive/index.js';
import type { Assertion } from '../../src/flow/index.js';
import { PARAMS, evidence } from './invariants-fixture.js';

/** The assertion invariant `id` expands to on the clean evidence. */
function expanded(id: InvariantId): Assertion {
  const r = expandInvariant(id, evidence(), PARAMS[id]);
  if (!r.ok) throw new Error('not expandable');
  return r.assertion;
}

const RESOLVABLE = [
  'crud-create-appears',
  'crud-edit-shows',
  'reload-keeps-data',
  'no-console-error',
  'round-trip-equality',
  'success-toast-implies-2xx',
] as const;

describe('invariantResolves', () => {
  it.each(RESOLVABLE)('accepts the expansion of %s', (id) => {
    expect(invariantResolves(expanded(id), PARAMS[id], evidence())).toEqual({
      ok: true,
    });
  });

  it('refuses a hand-edited status', () => {
    const a = expanded('success-toast-implies-2xx');
    const edited = {
      ...a,
      network: { method: 'POST', url: '/api/items', status: 200 },
    } as Assertion;
    expect(
      invariantResolves(
        edited,
        PARAMS['success-toast-implies-2xx'],
        evidence(),
      ),
    ).toEqual({ ok: false, reason: 'differs' });
  });

  it('refuses an extra within', () => {
    const a = {
      ...expanded('crud-create-appears'),
      within: { role: 'list' },
    } as Assertion;
    expect(
      invariantResolves(a, PARAMS['crud-create-appears'], evidence()),
    ).toMatchObject({ ok: false });
  });

  it('refuses a swapped ref', () => {
    const a = {
      ...expanded('crud-create-appears'),
      sourceRef: { kind: 'invariant', ref: 'no-console-error' },
    } as Assertion;
    expect(
      invariantResolves(a, PARAMS['crud-create-appears'], evidence()),
    ).toMatchObject({ ok: false });
  });

  it('refuses a ref that names no template', () => {
    const a = {
      ...expanded('no-console-error'),
      sourceRef: { kind: 'invariant', ref: 'no-4xx' },
    } as Assertion;
    expect(invariantResolves(a, {}, evidence())).toEqual({
      ok: false,
      reason: 'unknown_invariant',
    });
  });

  it('refuses an invariant sourceRef that carries a quote', () => {
    const a = expanded('no-console-error');
    const quoted = {
      ...a,
      sourceRef: {
        kind: 'invariant',
        ref: 'no-console-error',
        quote: 'no errors',
      },
    } as Assertion;
    expect(invariantResolves(quoted, {}, evidence())).toEqual({
      ok: false,
      reason: 'source_ref_extra',
    });
  });

  it('refuses a sourceRef of another kind and an assertion without one', () => {
    const a = expanded('no-console-error');
    const { sourceRef: _s, ...bare } = a;
    expect(invariantResolves(bare as Assertion, {}, evidence())).toEqual({
      ok: false,
      reason: 'no_source_ref',
    });
    const contract = {
      ...a,
      sourceRef: { kind: 'contract', ref: 'x' },
    } as Assertion;
    expect(invariantResolves(contract, {}, evidence())).toEqual({
      ok: false,
      reason: 'not_invariant',
    });
  });

  it('refuses a stale binding: the evidence no longer holds the step', () => {
    const a = expanded('success-toast-implies-2xx');
    expect(
      invariantResolves(a, PARAMS['success-toast-implies-2xx'], evidence([])),
    ).toMatchObject({ ok: false });
  });

  it('refuses an assertion of a template that is not expandable', () => {
    const a = {
      ...expanded('no-console-error'),
      sourceRef: { kind: 'invariant', ref: 'no-5xx' },
    } as Assertion;
    expect(invariantResolves(a, {}, evidence())).toEqual({
      ok: false,
      reason: 'not_expandable',
    });
  });

  it('refuses parameters the template does not define', () => {
    expect(
      invariantResolves(expanded('no-console-error'), { extra: 1 }, evidence()),
    ).toMatchObject({ ok: false, reason: 'bad_params' });
  });
});
