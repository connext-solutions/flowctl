import { describe, expect, it } from 'vitest';
import {
  addReviewerKey,
  readReviewerKeys,
  reviewerKeyId,
  reviewerKeyStatus,
  revokeReviewerKey,
  TrustStore,
  validateKeyRequest,
} from '../src/trust/index.js';
import { fresh, kindOf } from './rotate-fixture.js';
import { cfg, DAY, newPublicKey, NOW, REQ } from './trust-keys-fixture.js';
import { editStore, testOwnerKey, testStore } from './trust-fixture.js';

describe('reviewer key requests (T1.15)', () => {
  it('normalises the person to NFC and refuses hidden or oversized text', () => {
    const raw = { person: 'Nguyên', scope: 'flows', expires: '30' };
    expect(validateKeyRequest(raw).person).toBe('Nguyên');
    for (const person of [
      '',
      ' Alice',
      'Alice ',
      'Ali​ce',
      'Ali\nce',
      'Ali ce',
      'a'.repeat(129),
    ])
      expect(kindOf(() => validateKeyRequest({ ...raw, person }))).toBe(
        'trust_entry_invalid:',
      );
    expect(
      validateKeyRequest({ ...raw, person: 'a'.repeat(128) }).person,
    ).toHaveLength(128);
  });

  it('takes only the scopes flows and spec', () => {
    const raw = { person: 'Alice', scope: 'flows', expires: '30' };
    expect(validateKeyRequest({ ...raw, scope: 'spec' }).scope).toBe('spec');
    for (const scope of ['', 'FLOWS', 'both', 'flows,spec'])
      expect(kindOf(() => validateKeyRequest({ ...raw, scope }))).toBe(
        'trust_entry_invalid:',
      );
  });

  it('takes whole days from 1 to 365 and no default', () => {
    const raw = { person: 'Alice', scope: 'flows' };
    expect(validateKeyRequest({ ...raw, expires: '1' }).days).toBe(1);
    expect(validateKeyRequest({ ...raw, expires: '365' }).days).toBe(365);
    for (const expires of ['', '0', '366', '1.5', '-1', 'abc', '030', '1e2'])
      expect(kindOf(() => validateKeyRequest({ ...raw, expires }))).toBe(
        'trust_entry_invalid:',
      );
  });
});

describe('addReviewerKey and reviewerKeyStatus (T1.15)', () => {
  it('writes an owner-signed key entry that reads back with its id and expiry', () => {
    const store = testStore(cfg());
    const publicKey = newPublicKey();
    const added = addReviewerKey(
      store,
      testOwnerKey(),
      publicKey,
      REQ,
      'hardware',
      NOW,
    );
    expect(added.id).toBe(reviewerKeyId(publicKey));
    expect(added.id).toMatch(/^[0-9a-f]{64}$/);
    const { keys, revoked } = readReviewerKeys(TrustStore.open(store.dir));
    expect(revoked).toEqual([]);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      person: 'Alice Nguyen',
      scope: 'flows',
      custody: 'hardware',
      expiresAt: '2026-01-31T00:00:00.000Z',
      addedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(keys[0]?.publicKeyBytes.equals(publicKey)).toBe(true);
  });

  it('allows several active keys for one person and scope, and refuses one key twice', () => {
    const store = testStore(cfg());
    const first = newPublicKey();
    addReviewerKey(store, testOwnerKey(), first, REQ, 'file', NOW);
    addReviewerKey(store, testOwnerKey(), newPublicKey(), REQ, 'file', NOW);
    expect(readReviewerKeys(TrustStore.open(store.dir)).keys).toHaveLength(2);
    expect(
      kindOf(() =>
        addReviewerKey(
          store,
          testOwnerKey(),
          first,
          { ...REQ, scope: 'spec' },
          'file',
          NOW,
        ),
      ),
    ).toBe('trust_entry_invalid:');
  });

  it('judges a key by revocation, then scope, then expiry, on the caller clock', () => {
    const store = testStore(cfg());
    const publicKey = newPublicKey();
    const { id } = addReviewerKey(
      store,
      testOwnerKey(),
      publicKey,
      REQ,
      'file',
      NOW,
    );
    const at = (scope: 'flows' | 'spec', t: Date) =>
      reviewerKeyStatus(TrustStore.open(store.dir), id, scope, t).status;
    expect(at('flows', NOW)).toBe('valid');
    expect(at('flows', new Date(NOW.getTime() + 30 * DAY - 1))).toBe('valid');
    expect(at('flows', new Date(NOW.getTime() + 30 * DAY))).toBe('expired');
    expect(at('spec', NOW)).toBe('wrong_scope');
    expect(
      reviewerKeyStatus(
        TrustStore.open(store.dir),
        'f'.repeat(64),
        'flows',
        NOW,
      ).status,
    ).toBe('unknown');
    revokeReviewerKey(store, testOwnerKey(), id, 'left the team', NOW);
    expect(at('flows', NOW)).toBe('revoked');
    expect(at('spec', NOW)).toBe('revoked');
    expect(at('flows', new Date(NOW.getTime() + 99 * DAY))).toBe('revoked');
  });

  it('refuses a ci store and an owner key the store does not pin', () => {
    const store = testStore(cfg());
    editStore(store.dir, (d) => ({ ...d, markers: ['test', 'ci'] }));
    expect(
      kindOf(() =>
        addReviewerKey(store, testOwnerKey(), newPublicKey(), REQ, 'file', NOW),
      ),
    ).toBe('trust_entry_invalid:');
    const other = fresh();
    expect(
      kindOf(() =>
        addReviewerKey(
          TrustStore.open(other.storeDir),
          testOwnerKey(),
          newPublicKey(),
          REQ,
          'file',
          NOW,
        ),
      ),
    ).toBe('trust_tampered:owner_key_mismatch');
  });
});

describe('revokeReviewerKey (T1.15)', () => {
  it('appends a signed revocation, keeps the key entry, and refuses unknown or repeated revocations', () => {
    const store = testStore(cfg());
    const a = addReviewerKey(
      store,
      testOwnerKey(),
      newPublicKey(),
      REQ,
      'file',
      NOW,
    );
    const b = addReviewerKey(
      store,
      testOwnerKey(),
      newPublicKey(),
      REQ,
      'file',
      NOW,
    );
    const done = revokeReviewerKey(
      store,
      testOwnerKey(),
      a.id,
      'laptop lost',
      NOW,
    );
    expect(done).toMatchObject({ keyId: a.id, reason: 'laptop lost' });
    const reopened = TrustStore.open(store.dir);
    expect(reopened.data.reviewerKeys).toHaveLength(3);
    expect(readReviewerKeys(reopened).keys.map((k) => k.id)).toEqual([
      a.id,
      b.id,
    ]);
    expect(reviewerKeyStatus(reopened, b.id, 'flows', NOW).status).toBe(
      'valid',
    );
    expect(kindOf(() => revokeReviewerKey(store, testOwnerKey(), a.id))).toBe(
      'trust_entry_invalid:',
    );
    expect(
      kindOf(() => revokeReviewerKey(store, testOwnerKey(), 'e'.repeat(64))),
    ).toBe('trust_entry_invalid:');
    expect(
      kindOf(() =>
        revokeReviewerKey(store, testOwnerKey(), b.id, 'bad\nreason'),
      ),
    ).toBe('trust_entry_invalid:');
    expect(TrustStore.open(store.dir).data.reviewerKeys).toHaveLength(3);
  });
});

describe('the reviewerKeys section is read strictly (T1.15)', () => {
  const seeded = () => {
    const store = testStore(cfg());
    const a = addReviewerKey(
      store,
      testOwnerKey(),
      newPublicKey(),
      REQ,
      'file',
      NOW,
    );
    revokeReviewerKey(store, testOwnerKey(), a.id, undefined, NOW);
    return { store, a };
  };
  const tamper = (edit: (rows: unknown[]) => unknown[]) => {
    const { store } = seeded();
    editStore(store.dir, (d) => ({ ...d, reviewerKeys: edit(d.reviewerKeys) }));
    return kindOf(() => readReviewerKeys(TrustStore.open(store.dir)));
  };

  it('reads the untouched section', () => {
    const { store } = seeded();
    expect(
      kindOf(() => readReviewerKeys(TrustStore.open(store.dir))),
    ).toBeUndefined();
  });

  it.each([
    [
      'an edited person',
      (r: unknown[]) =>
        r.map((e, i) =>
          i === 0 ? { ...(e as object), person: 'Mallory' } : e,
        ),
      'bad_signature',
    ],
    [
      'an edited expiry',
      (r: unknown[]) =>
        r.map((e, i) =>
          i === 0
            ? { ...(e as object), expiresAt: '2099-01-01T00:00:00.000Z' }
            : e,
        ),
      'bad_signature',
    ],
    ['an unsigned element', (r: unknown[]) => [...r, {}]],
    [
      'an unknown field',
      (r: unknown[]) =>
        r.map((e, i) => (i === 0 ? { ...(e as object), extra: 1 } : e)),
    ],
    ['a duplicated key', (r: unknown[]) => [r[0], ...r]],
    ['a duplicated revocation', (r: unknown[]) => [...r, r[1]]],
    ['a deleted key with its revocation kept', (r: unknown[]) => r.slice(1)],
    ['a string element', (r: unknown[]) => [...r, 'x']],
  ])('refuses %s as trust_tampered', (_, edit, detail = 'reviewer_keys') => {
    expect(tamper(edit)).toBe(`trust_tampered:${detail}`);
  });

  it('refuses a revocation moved onto another key', () => {
    const { store } = seeded();
    const other = addReviewerKey(
      TrustStore.open(store.dir),
      testOwnerKey(),
      newPublicKey(),
      REQ,
      'file',
      NOW,
    );
    editStore(store.dir, (d) => ({
      ...d,
      reviewerKeys: d.reviewerKeys.map((e) => {
        const row = e as { kind: string; keyId?: string };
        return row.kind === 'revoked' ? { ...row, keyId: other.id } : e;
      }),
    }));
    expect(kindOf(() => readReviewerKeys(TrustStore.open(store.dir)))).toBe(
      'trust_tampered:bad_signature',
    );
  });
});
