import { describe, expect, it } from 'vitest';
import {
  addReviewerKey,
  loadOwnerKey,
  planReplace,
  planRotation,
  readReviewerKeys,
  replaceStore,
  reviewerKeyStatus,
  revokeReviewerKey,
  rotateOwner,
  TrustStore,
} from '../src/trust/index.js';
import { fresh, kindOf, NEW, SLOW } from './rotate-fixture.js';
import { newPublicKey, NOW, REQ } from './trust-keys-fixture.js';

describe('reviewer keys and owner-key rotation (T1.15)', () => {
  it(
    'rotates the owner key and replaces the store with a key and a revocation present',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key, init } = fresh();
      const store = TrustStore.open(storeDir);
      const a = addReviewerKey(store, key, newPublicKey(), REQ, 'file', NOW);
      const b = addReviewerKey(
        store,
        key,
        newPublicKey(),
        { ...REQ, scope: 'spec' },
        'hardware',
        NOW,
      );
      revokeReviewerKey(store, key, a.id, undefined, NOW);
      const plan = planRotation(storeDir);
      expect(plan.counts.reviewerKeys).toBe(3);
      const done = rotateOwner(storeDir, keyDir, plan, key, NEW);
      const after = TrustStore.open(storeDir);
      expect(after.data.ownerFingerprint).toBe(done.fingerprint);
      expect(reviewerKeyStatus(after, a.id, 'flows', NOW).status).toBe(
        'revoked',
      );
      expect(reviewerKeyStatus(after, b.id, 'spec', NOW).status).toBe('valid');
      expect(kindOf(() => readReviewerKeys(after))).toBeUndefined();
      const replaceKey = loadOwnerKey(keyDir, NEW);
      replaceStore(
        storeDir,
        keyDir,
        planReplace(storeDir),
        replaceKey,
        'yet another long passphrase',
        init,
      );
      expect(TrustStore.open(storeDir).data.reviewerKeys).toEqual([]);
    },
  );
});
