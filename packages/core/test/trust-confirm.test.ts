import { describe, expect, it } from 'vitest';
import {
  readConfirmEntries,
  revokeConfirmEntry,
  TrustStore,
} from '../src/trust/index.js';
import {
  CREATE,
  ctx,
  denied,
  MUTATE,
  refusal,
  save,
  SESSION,
  store,
} from './confirm-fixture.js';
import { editStore, testOwnerKey } from './trust-fixture.js';

/**
 * Stored destructive confirmations (ADR 0024 section 5 and its amendment 2026-11-12 "destructive ledger details"):
 * owner-signed `destructiveConfirm` entries, entries ignored at read (`trust_entry_invalid`), expiry, replacement and
 * revocation.
 */
describe('destructiveConfirm entries', () => {
  it('writes signed entries and reads them back', () => {
    const s = store();
    save(s, [CREATE, MUTATE, SESSION]);
    const r = readConfirmEntries(TrustStore.open(s.dir), ctx);
    expect(r.invalid).toEqual([]);
    expect(r.entries.map((e) => e.id)).toEqual([
      'items-create',
      'items-rename',
      'login',
    ]);
  });

  it.each([
    ['an unknown field', { ...CREATE, extra: 1 }],
    ['a 63-character hash', { ...CREATE, hash: 'a'.repeat(63) }],
    [
      'a conflictStatus other than 409 or 422',
      { ...CREATE, conflictStatus: [500] },
    ],
    [
      'a kind for GET',
      { ...SESSION, id: 'items-create', kind: 'read', method: 'GET' },
    ],
  ])(
    'ignores a signed entry with %s as trust_entry_invalid, keeping the others',
    (_what, value) => {
      const s = store();
      save(s, [SESSION]);
      const key = testOwnerKey();
      editStore(s.dir, (d) => ({
        ...d,
        destructiveConfirm: [
          ...d.destructiveConfirm,
          {
            value,
            sig: key.signEntry({
              id: 'items-create',
              kind: 'destructiveConfirm',
              value,
            }),
          },
        ],
      }));
      const r = readConfirmEntries(TrustStore.open(s.dir), ctx);
      expect(r.invalid.map((i) => i.id)).toEqual(['items-create']);
      expect(r.entries.map((e) => e.id)).toEqual(['login']);
    },
  );

  it('ignores a mutate whose create entry is invalid, and an entry whose env origin changed', () => {
    const s = store();
    save(s, [CREATE, MUTATE]);
    editStore(s.dir, (d) => {
      const stg = d.envs['stg'];
      if (stg === undefined) throw new Error('no stg');
      const { sig: _sig, ...value } = {
        ...stg,
        origin: 'https://stg2.example.com',
      };
      return {
        ...d,
        envs: {
          ...d.envs,
          stg: {
            ...value,
            sig: testOwnerKey().signEntry({ id: 'stg', kind: 'envs', value }),
          },
        },
      };
    });
    const r = readConfirmEntries(TrustStore.open(s.dir), ctx);
    expect(r.entries).toEqual([]);
    expect(r.invalid.map((i) => i.id).sort()).toEqual([
      'items-create',
      'items-rename',
    ]);
  });

  it('refuses an entry whose value was changed after signing', () => {
    const s = store();
    save(s, [SESSION]);
    editStore(s.dir, (d) => ({
      ...d,
      destructiveConfirm: d.destructiveConfirm.map((raw) =>
        typeof raw === 'object' &&
        raw !== null &&
        'value' in raw &&
        'sig' in raw
          ? { sig: raw.sig, value: { ...SESSION, template: '/api/session' } }
          : raw,
      ),
    }));
    expect(
      refusal(() => readConfirmEntries(TrustStore.open(s.dir), ctx)),
    ).toMatch(/^trust_tampered/);
  });

  it('treats an entry past its expiry date (UTC) as absent', () => {
    const s = store();
    save(s, [{ ...SESSION, expires: '2026-11-13' }]);
    const at = (iso: string) =>
      readConfirmEntries(TrustStore.open(s.dir), {
        now: new Date(iso),
        denied,
      });
    expect(at('2026-11-13T23:59:59.999Z').entries).toHaveLength(1);
    const next = at('2026-11-14T00:00:00.000Z');
    expect(next.entries).toEqual([]);
    expect(next.expired).toEqual(['login']);
  });

  it('replaces the entries of the same flow and env, and refuses an id of another flow', () => {
    const s = store();
    save(s, [CREATE, MUTATE]);
    save(TrustStore.open(s.dir), [{ ...SESSION, flow: 'items-crud' }]);
    expect(
      readConfirmEntries(TrustStore.open(s.dir), ctx).entries.map((e) => e.id),
    ).toEqual(['login']);
    expect(
      refusal(() =>
        save(TrustStore.open(s.dir), [
          { ...CREATE, flow: 'third-flow', id: 'login' },
        ]),
      ),
    ).toMatch(/^trust_entry_invalid: .*used twice/);
  });

  it('revokes an entry and the mutate entries that depend on it', () => {
    const s = store();
    save(s, [CREATE, MUTATE, SESSION]);
    expect(
      revokeConfirmEntry(
        TrustStore.open(s.dir),
        testOwnerKey(),
        'items-create',
      ),
    ).toEqual(['items-create', 'items-rename']);
    expect(
      readConfirmEntries(TrustStore.open(s.dir), ctx).entries.map((e) => e.id),
    ).toEqual(['login']);
    expect(
      refusal(() =>
        revokeConfirmEntry(
          TrustStore.open(s.dir),
          testOwnerKey(),
          'items-create',
        ),
      ),
    ).toMatch(/^trust_entry_invalid/);
  });
});
