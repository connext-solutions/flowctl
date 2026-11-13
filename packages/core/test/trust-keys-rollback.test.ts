import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { TrustError } from '../src/trust/errors.js';
import {
  createReviewerKey,
  readReviewerKeys,
  TrustStore,
} from '../src/trust/index.js';
import { testOwnerKey, testStore } from './trust-fixture.js';
import { cfg, NOW, REQ } from './trust-keys-fixture.js';

type Write = typeof import('../src/trust/write.js');
const mode = vi.hoisted(() => ({ value: 'after-commit' as string }));
vi.mock('../src/trust/write.js', async (original) => {
  const real = await original<Write>();
  return {
    ...real,
    replaceStoreDoc: (...args: Parameters<Write['replaceStoreDoc']>) => {
      if (mode.value === 'before-commit')
        throw new TrustError('store_busy', 'changed meanwhile');
      real.replaceStoreDoc(...args);
      throw new TrustError(
        'trust_tampered',
        'The change was saved, but the anchor could not be updated.',
        'anchor_unreachable',
      );
    },
  };
});

describe('createReviewerKey rollback (T1.15)', () => {
  const PASS = 'a long enough reviewer passphrase';
  const dir = (): string =>
    join(mkdtempSync(join(tmpdir(), 'flowctl-rollback-')), 'keys');

  it('keeps the key files when the entry was committed and a later step failed', () => {
    mode.value = 'after-commit';
    const store = testStore(cfg());
    const keys = dir();
    expect(() =>
      createReviewerKey(
        store,
        testOwnerKey(),
        REQ,
        { dir: keys, excluded: [] },
        PASS,
        NOW,
      ),
    ).toThrow(/anchor/);
    const { keys: registered } = readReviewerKeys(TrustStore.open(store.dir));
    expect(registered).toHaveLength(1);
    expect(existsSync(join(keys, `${registered[0]?.id}.key`))).toBe(true);
    expect(existsSync(join(keys, `${registered[0]?.id}.pub`))).toBe(true);
  });

  it('removes the key files when nothing was committed', () => {
    mode.value = 'before-commit';
    const store = testStore(cfg());
    const keys = dir();
    expect(() =>
      createReviewerKey(
        store,
        testOwnerKey(),
        REQ,
        { dir: keys, excluded: [] },
        PASS,
        NOW,
      ),
    ).toThrow(/changed meanwhile/);
    expect(readReviewerKeys(TrustStore.open(store.dir)).keys).toHaveLength(0);
    expect(existsSync(keys) ? readdirSync(keys) : []).toEqual([]);
  });
});
