import { describe, expect, it } from 'vitest';
import { requiredRevision } from '../src/provenance/index.js';
import { checkRecords as check, world } from './approval-fixture.js';
import { editStore } from './trust-fixture.js';

const KEY = 'test-project/pv';

describe('requiredRevision (ADR 0020 section l)', () => {
  it('is the maximum of the sources that exist, absent when none does', () => {
    expect(requiredRevision({})).toEqual({ rollbackNotChecked: true });
    expect(requiredRevision({ floor: 4 })).toEqual({
      required: 4,
      rollbackNotChecked: false,
    });
    expect(requiredRevision({ floor: 4, latest: 6, mergeBase: 5 })).toEqual({
      required: 6,
      rollbackNotChecked: false,
    });
    expect(requiredRevision({ mergeBase: 2 }).rollbackNotChecked).toBe(false);
  });
});

describe('checkApprovals: the floor table', () => {
  it('verifies with rollback_not_checked when the store has no value', () => {
    const w = world();
    const r = check(w, [w.record()]);
    expect(r.verified).toBe(true);
    expect(r.notes).toContain('rollback_not_checked');
  });

  it.each<[string, { floor: number; latest?: number }, number, boolean]>([
    ['floor 4, record 4', { floor: 4 }, 4, true],
    ['floor 4, record 3', { floor: 4 }, 3, false],
    ['floor 4, latest 6, record 5', { floor: 4, latest: 6 }, 5, false],
    ['floor 4, latest 6, record 6', { floor: 4, latest: 6 }, 6, true],
  ])('%s', (_n, stored, revision, ok) => {
    const w = world();
    editStore(w.store.dir, (d) => ({
      ...d,
      flowFloors: { [KEY]: stored.floor },
      latestRevision: Object.fromEntries(
        stored.latest === undefined ? [] : [[KEY, stored.latest]],
      ),
    }));
    const r = check(w, [w.record({ revision })]);
    expect(r.verified).toBe(ok);
    expect(r.notes.includes('revision_below_floor')).toBe(!ok);
    expect(r.notes).not.toContain('rollback_not_checked');
  });

  it('takes the merge-base value as a third term', () => {
    const w = world();
    const r = check(w, [w.record({ revision: 2 })], { mergeBaseRevision: 3 });
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('revision_below_floor');
  });
});
