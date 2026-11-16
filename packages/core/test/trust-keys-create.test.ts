import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createReviewerKey,
  parsePublicKey,
  readReviewerKeys,
  reviewerKeyId,
  TrustStore,
} from '../src/trust/index.js';
import { kindOf } from './rotate-fixture.js';
import { editStore, testOwnerKey, testStore } from './trust-fixture.js';
import { cfg, NOW, REQ } from './trust-keys-fixture.js';

describe('createReviewerKey (T1.15)', () => {
  const PASS = 'a long enough reviewer passphrase';
  const tmp = (): string => mkdtempSync(join(tmpdir(), 'flowctl-newkey-'));

  it('writes the key files and registers the entry in one step, under the key id by default', () => {
    const store = testStore(cfg());
    const dir = join(tmp(), 'reviewers');
    const { key, files } = createReviewerKey(
      store,
      testOwnerKey(),
      REQ,
      { dir, excluded: [] },
      PASS,
      NOW,
    );
    expect(files.keyFile.endsWith(join('reviewers', `${key.id}.key`))).toBe(
      true,
    );
    expect(
      parsePublicKey(readFileSync(files.pubFile, 'utf8')).equals(
        files.publicKey,
      ),
    ).toBe(true);
    const { keys } = readReviewerKeys(TrustStore.open(store.dir));
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({
      id: key.id,
      custody: 'file',
      scope: 'flows',
    });
    expect(reviewerKeyId(files.publicKey)).toBe(key.id);
  });

  it('honours --out, and writes nothing for a ci store, a short passphrase or a path in the store', () => {
    const store = testStore(cfg());
    const out = join(tmp(), 'mine.key');
    const target = { out, excluded: [] };
    expect(
      kindOf(() =>
        createReviewerKey(store, testOwnerKey(), REQ, target, 'short', NOW),
      ),
    ).toBe('passphrase_too_short:');
    expect(existsSync(out)).toBe(false);
    expect(
      kindOf(() =>
        createReviewerKey(
          store,
          testOwnerKey(),
          REQ,
          { out: join(store.dir, 'k.key'), excluded: [] },
          PASS,
          NOW,
        ),
      ),
    ).toBe('trust_entry_invalid:key_path_in_key_dir');
    createReviewerKey(store, testOwnerKey(), REQ, target, PASS, NOW);
    expect(existsSync(out)).toBe(true);
    editStore(store.dir, (d) => ({ ...d, markers: ['test', 'ci'] }));
    const blocked = join(tmp(), 'ci.key');
    expect(
      kindOf(() =>
        createReviewerKey(
          TrustStore.open(store.dir),
          testOwnerKey(),
          REQ,
          { out: blocked, excluded: [] },
          PASS,
          NOW,
        ),
      ),
    ).toBe('trust_entry_invalid:');
    expect(existsSync(blocked)).toBe(false);
  });
});
