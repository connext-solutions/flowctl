import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addSystem1,
  loadOwnerKey,
  planRotation,
  rotateOwner,
  TrustStore,
  trustedSystem1,
} from '../src/trust/index.js';
import { readAnchor } from '../src/trust/anchor.js';
import { editStore } from './trust-fixture.js';
import {
  fresh,
  kindOf,
  NEW,
  OLD,
  retired,
  SLOW,
  staged,
} from './rotate-fixture.js';

describe('trust key rotate-owner (ADR 0025 Amendment 2026-11-02 section 5)', () => {
  it(
    're-signs every entry, keeps the old log verifiable and retires the old key',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      addSystem1(TrustStore.open(storeDir), key, {
        host: 'api.typesafe.ai:443',
        apiKeyEnv: 'TYPESAFE_API_KEY',
        envs: ['local'],
      });
      const plan = planRotation(storeDir);
      expect(plan.counts).toMatchObject({
        projects: 1,
        roots: 1,
        anchor: 1,
        system1: 1,
      });
      expect(plan.storeSha256).toMatch(/^[0-9a-f]{64}$/);
      const done = rotateOwner(storeDir, keyDir, plan, key, NEW);
      const store = TrustStore.open(storeDir);
      expect(trustedSystem1(store)?.allowedHosts).toEqual([
        'api.typesafe.ai:443',
      ]);
      expect(store.data.ownerFingerprint).toBe(done.fingerprint);
      expect(store.log.map((l) => l.kind)).toEqual([
        'genesis',
        'write',
        'write',
        'rotate',
        'write',
      ]);
      expect(readAnchor(store.anchor.location)).toMatchObject({
        ownerFingerprint: done.fingerprint,
        head: store.data.head,
        pending: null,
      });
      expect(loadOwnerKey(keyDir, NEW).fingerprint).toBe(done.fingerprint);
      expect(retired(keyDir)).toEqual([done.retired]);
      expect(staged(storeDir, keyDir)).toBe(false);
      const value = { loginOrigins: [], envVars: [] };
      expect(
        kindOf(() =>
          store.assertSigned(
            { id: 'employee', kind: 'profiles', value },
            key.signEntry({ id: 'employee', kind: 'profiles', value }),
          ),
        ),
      ).toBe('trust_tampered:bad_signature');
    },
  );

  it(
    'two rotations on one day keep both retired keys',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      expect(
        kindOf(() =>
          rotateOwner(storeDir, keyDir, planRotation(storeDir), key, 'short'),
        ),
      ).toBe('passphrase_too_short:');
      expect(staged(storeDir, keyDir)).toBe(false);
      rotateOwner(storeDir, keyDir, planRotation(storeDir), key, NEW);
      const second = loadOwnerKey(keyDir, NEW);
      rotateOwner(storeDir, keyDir, planRotation(storeDir), second, OLD);
      const names = retired(keyDir);
      expect(names).toHaveLength(2);
      expect(names[0]).toMatch(/\.1$/);
      expect(names[1]).toMatch(/\.2$/);
      expect(
        TrustStore.open(storeDir).log.filter((l) => l.kind === 'rotate'),
      ).toHaveLength(2);
    },
  );

  it(
    'refuses a forged rotate line and a section it cannot re-sign',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      rotateOwner(storeDir, keyDir, planRotation(storeDir), key, NEW);
      const file = join(storeDir, 'trust.log');
      const good = readFileSync(file, 'utf8');
      const forged = good.replace(/"sigNew":"[^"]{4}/, '"sigNew":"AAAA');
      expect(forged).not.toBe(good);
      writeFileSync(file, forged, { mode: 0o600 });
      expect(kindOf(() => TrustStore.open(storeDir))).toBe(
        'trust_tampered:log_chain',
      );
      writeFileSync(file, good, { mode: 0o600 });
      editStore(storeDir, (d) => ({ ...d, reviewerKeys: [{}] }));
      expect(kindOf(() => planRotation(storeDir))).toBe('rotate_unverified:');
    },
  );

  it(
    'refuses a store whose entries do not verify, and one that changed since the plan',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key } = fresh();
      const plan = planRotation(storeDir);
      editStore(storeDir, (d) => {
        const p = d.projects['test-project'];
        if (p !== undefined) p.language = 'en';
        return d;
      });
      expect(kindOf(() => planRotation(storeDir))).toBe('rotate_unverified:');
      expect(kindOf(() => rotateOwner(storeDir, keyDir, plan, key, NEW))).toBe(
        'store_busy:',
      );
      expect(
        kindOf(() =>
          rotateOwner(
            storeDir,
            keyDir,
            { head: TrustStore.open(storeDir).data.head ?? '' },
            key,
            'short',
          ),
        ),
      ).toBe('rotate_unverified:');
      expect(staged(storeDir, keyDir)).toBe(false);
    },
  );
});
