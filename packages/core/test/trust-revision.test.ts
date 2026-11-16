import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MAX_REVISION,
  raiseLatestRevision,
  replaceStoreDoc,
  revisionKey,
  storedRevisions,
  TrustStore,
  type OwnerKey,
} from '../src/trust/index.js';
import { kindOf } from './rotate-fixture.js';
import { cfg } from './trust-keys-fixture.js';
import { editStore, testStore } from './trust-fixture.js';

const reopen = (s: TrustStore) => TrustStore.open(s.dir);

describe('raiseLatestRevision (T4.5)', () => {
  it('writes a revision for (project, flow) and changes nothing else', () => {
    const store = testStore(cfg());
    const before = structuredClone(store.data);
    raiseLatestRevision(store, 'test-project', 'a-flow', 3);
    const after = reopen(store).data;
    expect(after.latestRevision).toEqual({ 'test-project/a-flow': 3 });
    const { latestRevision: _l, head: _h, ...rest } = after;
    const { latestRevision: _b, head: _bh, ...was } = before;
    expect(rest).toEqual(was);
    expect(storedRevisions(reopen(store), 'test-project', 'a-flow')).toEqual({
      latest: 3,
    });
  });

  it('only goes up: a lower value is refused, an equal one is a no-op', () => {
    const store = testStore(cfg());
    raiseLatestRevision(store, 'test-project', 'a-flow', 5);
    expect(
      kindOf(() => raiseLatestRevision(store, 'test-project', 'a-flow', 4)),
    ).toBe('trust_entry_invalid:');
    const head = reopen(store).data.head;
    raiseLatestRevision(store, 'test-project', 'a-flow', 5);
    expect(reopen(store).data.head).toBe(head);
    raiseLatestRevision(store, 'test-project', 'a-flow', 6);
    expect(reopen(store).data.latestRevision['test-project/a-flow']).toBe(6);
  });

  it('refuses a revision outside 1..2^53-1 and a ci store', () => {
    const store = testStore(cfg());
    for (const bad of [0, -1, 1.5, MAX_REVISION + 1, Number.NaN])
      expect(
        kindOf(() => raiseLatestRevision(store, 'test-project', 'f', bad)),
      ).toBe('trust_entry_invalid:');
    editStore(store.dir, (d) => ({ ...d, markers: ['ci'] }));
    expect(
      kindOf(() => raiseLatestRevision(reopen(store), 'test-project', 'f', 2)),
    ).toBe('trust_entry_invalid:');
  });

  it('reads floors, and treats a bad stored value as tampering', () => {
    const store = testStore(cfg());
    editStore(store.dir, (d) => ({
      ...d,
      flowFloors: { [revisionKey('test-project', 'f')]: 4 },
    }));
    expect(storedRevisions(reopen(store), 'test-project', 'f')).toEqual({
      floor: 4,
    });
    expect(storedRevisions(reopen(store), 'test-project', 'g')).toEqual({});
    editStore(store.dir, (d) => ({
      ...d,
      latestRevision: { [revisionKey('test-project', 'f')]: 0 },
    }));
    expect(
      kindOf(() => storedRevisions(reopen(store), 'test-project', 'f')),
    ).toBe('trust_tampered:revision_value');
  });

  it('refuses when the store on disk became ci after the caller opened it', () => {
    const store = testStore(cfg());
    editStore(store.dir, (d) => ({ ...d, markers: ['ci'] }));
    expect(
      kindOf(() => raiseLatestRevision(store, 'test-project', 'f', 2)),
    ).toBe('trust_entry_invalid:');
    expect(reopen(store).data.latestRevision).toEqual({});
  });

  it('keeps a change made after the caller opened the store, and changes only latestRevision', () => {
    const store = testStore(cfg());
    editStore(store.dir, (d) => ({
      ...d,
      flowFloors: { [revisionKey('test-project', 'f')]: 2 },
    }));
    raiseLatestRevision(store, 'test-project', 'f', 3);
    const after = reopen(store).data;
    expect(after.flowFloors).toEqual({ 'test-project/f': 2 });
    expect(after.latestRevision).toEqual({ 'test-project/f': 3 });
  });

  it('leaves replaceStoreDoc needing an unlocked owner key', () => {
    expectTypeOf(replaceStoreDoc).parameter(2).toEqualTypeOf<OwnerKey>();
  });
});
