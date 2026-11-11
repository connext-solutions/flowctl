import { chmodSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createOwnerKey,
  loadOwnerKey,
  planRotation,
  recoverRotation,
  rotateOwner,
  rotateOwnerUntil,
  TrustStore,
} from '../src/trust/index.js';
import {
  fresh,
  kindOf,
  NEW,
  OLD,
  retired,
  SLOW,
  staged,
} from './rotate-fixture.js';

describe('trust key rotate-owner crash recovery (ADR 0025 Amendment 2026-11-02 section 5)', () => {
  it(
    'a crash before the commit rolls back to the old key',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      const plan = planRotation(storeDir);
      expect(() =>
        rotateOwnerUntil(storeDir, keyDir, plan, key, NEW, 'staged'),
      ).toThrow('simulated crash');
      expect(kindOf(() => TrustStore.open(storeDir))).toBe(
        'rotate_incomplete:',
      );
      expect(kindOf(() => loadOwnerKey(keyDir, OLD))).toBe(
        'rotate_incomplete:',
      );
      expect(recoverRotation(storeDir, keyDir)).toBe('rolled_back');
      const store = TrustStore.open(storeDir);
      expect(store.data.ownerFingerprint).toBe(key.fingerprint);
      expect(store.anchor.record.pending).toBeNull();
      expect(staged(storeDir, keyDir)).toBe(false);
      expect(recoverRotation(storeDir, keyDir)).toBe('none');
      rotateOwner(storeDir, keyDir, planRotation(storeDir), key, NEW);
      expect(loadOwnerKey(keyDir, NEW).fingerprint).toBe(
        TrustStore.open(storeDir).data.ownerFingerprint,
      );
    },
  );

  for (const at of ['commit', 'log'] as const)
    it(
      `a crash after the ${at} rename completes on rerun`,
      { timeout: SLOW },
      () => {
        const { storeDir, keyDir, key } = fresh();
        const plan = planRotation(storeDir);
        expect(() =>
          rotateOwnerUntil(storeDir, keyDir, plan, key, NEW, at),
        ).toThrow('simulated crash');
        expect(recoverRotation(storeDir, keyDir)).toBe('completed');
        const store = TrustStore.open(storeDir);
        expect(loadOwnerKey(keyDir, NEW).fingerprint).toBe(
          store.data.ownerFingerprint,
        );
        expect(store.anchor.record).toMatchObject({
          ownerFingerprint: store.data.ownerFingerprint,
          pending: null,
        });
        expect(retired(keyDir)).toHaveLength(1);
        expect(staged(storeDir, keyDir)).toBe(false);
      },
    );

  it(
    'a leftover owner.key.new after a finished rotation is dropped, never installed',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      const done = rotateOwner(
        storeDir,
        keyDir,
        planRotation(storeDir),
        key,
        NEW,
      );
      createOwnerKey(keyDir, OLD, 'owner.key.new');
      expect(recoverRotation(storeDir, keyDir)).toBe('rolled_back');
      expect(loadOwnerKey(keyDir, NEW).fingerprint).toBe(done.fingerprint);
    },
  );

  it(
    'a second rotation that crashes after its new key never installs it, even when the first left its anchor pending',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      expect(() =>
        rotateOwnerUntil(
          storeDir,
          keyDir,
          planRotation(storeDir),
          key,
          NEW,
          'log',
        ),
      ).toThrow('simulated crash');
      renameSync(
        join(keyDir, 'owner.key'),
        join(keyDir, 'owner.key.retired-manual'),
      );
      renameSync(join(keyDir, 'owner.key.new'), join(keyDir, 'owner.key'));
      const first = loadOwnerKey(keyDir, NEW);
      expect(TrustStore.open(storeDir).anchor.record.pending).not.toBeNull();
      expect(() =>
        rotateOwnerUntil(
          storeDir,
          keyDir,
          { head: TrustStore.open(storeDir).data.head ?? '' },
          first,
          OLD,
          'key',
        ),
      ).toThrow('simulated crash');
      expect(recoverRotation(storeDir, keyDir)).toBe('rolled_back');
      expect(loadOwnerKey(keyDir, NEW).fingerprint).toBe(
        TrustStore.open(storeDir).data.ownerFingerprint,
      );
    },
  );

  it(
    'finishes an anchor a rotation left pending, and refuses files that match no rotation step',
    { timeout: SLOW },
    () => {
      const a = fresh();
      expect(() =>
        rotateOwnerUntil(
          a.storeDir,
          a.keyDir,
          planRotation(a.storeDir),
          a.key,
          NEW,
          'log',
        ),
      ).toThrow('simulated crash');
      renameSync(join(a.keyDir, 'owner.key'), join(a.keyDir, 'owner.key.old'));
      renameSync(join(a.keyDir, 'owner.key.new'), join(a.keyDir, 'owner.key'));
      expect(recoverRotation(a.storeDir, a.keyDir)).toBe('completed');
      expect(TrustStore.open(a.storeDir).anchor.record.pending).toBeNull();
      expect(recoverRotation(a.storeDir, a.keyDir)).toBe('none');
      const b = fresh();
      expect(() =>
        rotateOwnerUntil(
          b.storeDir,
          b.keyDir,
          planRotation(b.storeDir),
          b.key,
          NEW,
          'commit',
        ),
      ).toThrow('simulated crash');
      rmSync(join(b.storeDir, 'trust.log.new'));
      expect(kindOf(() => recoverRotation(b.storeDir, b.keyDir))).toBe(
        'trust_tampered:rotate_state',
      );
    },
  );

  it(
    'a failure after staging removes what it staged and keeps the old key',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      const anchorDir = dirname(
        TrustStore.open(storeDir).anchor.location.locator,
      );
      chmodSync(anchorDir, 0o500);
      try {
        expect(
          kindOf(() =>
            rotateOwner(storeDir, keyDir, planRotation(storeDir), key, NEW),
          ),
        ).toMatch(/^trust_tampered:anchor_unreachable|^anchor_unavailable/);
      } finally {
        chmodSync(anchorDir, 0o700);
      }
      expect(staged(storeDir, keyDir)).toBe(false);
      expect(TrustStore.open(storeDir).data.ownerFingerprint).toBe(
        key.fingerprint,
      );
      expect(loadOwnerKey(keyDir, OLD).fingerprint).toBe(key.fingerprint);
    },
  );
});
