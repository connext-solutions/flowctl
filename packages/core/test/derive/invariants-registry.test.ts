import { describe, expect, it } from 'vitest';
import {
  INVARIANT_IDS,
  INVARIANTS,
  evaluateInvariant,
  isInvariantId,
  isSmokeOnly,
} from '../../src/derive/index.js';
import { CHECK_IDS } from '../../src/observe/index.js';
import { PARAMS, evidence } from './invariants-fixture.js';

describe('invariant registry', () => {
  it('holds exactly the ten invariants, each under its own id', () => {
    expect([...INVARIANT_IDS]).toHaveLength(10);
    expect(Object.keys(INVARIANTS).sort()).toEqual([...INVARIANT_IDS].sort());
    for (const id of INVARIANT_IDS) expect(INVARIANTS[id].id).toBe(id);
  });

  it('shares its two free ids with the free checks', () => {
    for (const id of ['no-5xx', 'no-console-error'] as const)
      expect(CHECK_IDS).toContain(id);
  });

  it.each([...INVARIANT_IDS])(
    '%s refuses a parameter it does not define',
    (id) => {
      const params = { ...PARAMS[id], extra: 'x' };
      const r = evaluateInvariant(id, evidence(), params);
      expect(r).toMatchObject({ ok: false, reason: 'bad_params' });
    },
  );

  it.each([
    ['a free-text status class', { statusClass: '5xx' }],
    ['a free-text absent', { absent: true }],
    ['a free-text ref', { ref: 'no-5xx' }],
  ])('no-5xx refuses %s', (_name, params) => {
    expect(evaluateInvariant('no-5xx', evidence(), params)).toMatchObject({
      reason: 'bad_params',
    });
  });

  it('refuses a value input name that is not a flow name', () => {
    const r = evaluateInvariant('crud-create-appears', evidence(), {
      ...PARAMS['crud-create-appears'],
      valueFrom: 'Tên mục',
    });
    expect(r).toMatchObject({ reason: 'bad_params' });
  });

  it('knows its ids', () => {
    expect(isInvariantId('no-5xx')).toBe(true);
    expect(isInvariantId('no-4xx')).toBe(false);
  });

  it('calls a case of free checks only smoke-only', () => {
    expect(isSmokeOnly(['no-5xx', 'no-console-error'])).toBe(true);
    expect(isSmokeOnly(['no-5xx', 'crud-create-appears'])).toBe(false);
    expect(isSmokeOnly([])).toBe(false);
  });
});
