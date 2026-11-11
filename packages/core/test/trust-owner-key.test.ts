import { gitInit, rawStore } from './trust-fixture.js';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createOwnerKey,
  fingerprintOf,
  loadOwnerKey,
  type OwnerKey,
  TrustError,
  TrustStore,
  verifyEntry,
} from '../src/trust/index.js';

const PASS = 'correct horse battery staple';
const SLOW = 60_000;

/** Writes a structurally valid `owner.key` (right field lengths, unusable ciphertext) with overrides. */
function writeFakeKey(dir: string, over: Record<string, unknown>): void {
  const doc = {
    v: 1,
    kdf: 'scrypt',
    N: 131_072,
    r: 8,
    p: 1,
    salt: Buffer.alloc(16).toString('base64'),
    nonce: Buffer.alloc(12).toString('base64'),
    ct: Buffer.alloc(48).toString('base64'),
    ...over,
  };
  writeFileSync(join(dir, 'owner.key'), JSON.stringify(doc), { mode: 0o400 });
}

/**
 * C2-minimal of T1.0: the owner key (ADR 0025 Amendment 2026-11-02 section 5) and signed entries,
 * verified against the key pinned in the store. Rotation, replace, `trust.log` and the anchor come later.
 * Canonical JSON has its own file, `trust-canonical.test.ts`.
 */
describe('owner key', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowctl-key-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const expectKind = (fn: () => unknown, kind: string): void => {
    try {
      fn();
      throw new Error(`expected TrustError ${kind}`);
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.kind).toBe(kind);
    }
  };

  const expectTampered = (fn: () => unknown, detail: string): void => {
    try {
      fn();
      throw new Error(`expected trust_tampered ${detail}`);
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) {
        expect(e.kind).toBe('trust_tampered');
        expect(e.detail).toBe(detail);
      }
    }
  };

  it(
    'creates a 0400 key file in a 0700 dir and signs entries the public key verifies',
    () => {
      const keyDir = join(dir, 'keys');
      const key = createOwnerKey(keyDir, PASS);
      expect(statSync(keyDir).mode & 0o777).toBe(0o700);
      expect(statSync(join(keyDir, 'owner.key')).mode & 0o777).toBe(0o400);
      expect(key.fingerprint).toBe(fingerprintOf(key.publicKey));

      const entry = { id: 'checkout', kind: 'hooks', value: { digest: 'abc' } };
      const sig = key.signEntry(entry);
      expect(verifyEntry(key.publicKey, entry, sig)).toBe(true);
      expect(
        verifyEntry(key.publicKey, { ...entry, value: { digest: 'abd' } }, sig),
      ).toBe(false);

      const loaded = loadOwnerKey(keyDir, PASS);
      expect(loaded.fingerprint).toBe(key.fingerprint);
      expect(verifyEntry(key.publicKey, entry, loaded.signEntry(entry))).toBe(
        true,
      );
    },
    SLOW,
  );

  it('refuses a passphrase under 16 code points', () => {
    expectKind(
      () => createOwnerKey(dir, 'fifteen-chars!!'),
      'passphrase_too_short',
    );
  });

  it('never overwrites an existing key file', { timeout: SLOW }, () => {
    createOwnerKey(dir, PASS);
    expectKind(() => createOwnerKey(dir, PASS), 'key_exists');
  });

  it('refuses a key file below the scrypt floors before deriving', () => {
    writeFakeKey(dir, { N: 1024 });
    expectKind(() => loadOwnerKey(dir, PASS), 'key_params_weak');
  });

  it.each([
    ['N above the ceiling', { N: 2_097_152 }],
    ['r below the floor', { r: 4 }],
    ['p above the cap', { p: 64 }],
  ])('refuses %s as key_params_weak', (_name, over) => {
    writeFakeKey(dir, over);
    expectKind(() => loadOwnerKey(dir, PASS), 'key_params_weak');
  });

  it('refuses parameters scrypt cannot run within maxmem, before deriving', () => {
    writeFakeKey(dir, { N: 262_144 });
    expectKind(() => loadOwnerKey(dir, PASS), 'key_params_unsupported');
  });

  it('refuses a damaged file (wrong nonce length) before deriving', () => {
    writeFakeKey(dir, { nonce: Buffer.alloc(5).toString('base64') });
    expectKind(() => loadOwnerKey(dir, PASS), 'key_unlock_failed');
  });

  it.each([0o440, 0o404, 0o640])('refuses a key file with mode %o', (mode) => {
    writeFakeKey(dir, {});
    chmodSync(join(dir, 'owner.key'), mode);
    expectTampered(() => loadOwnerKey(dir, PASS), 'key_file');
  });

  it('refuses a key file that is a symlink', () => {
    const other = join(dir, 'elsewhere');
    mkdirSync(other, { mode: 0o700 });
    writeFakeKey(other, {});
    symlinkSync(join(other, 'owner.key'), join(dir, 'owner.key'));
    expectTampered(() => loadOwnerKey(dir, PASS), 'key_file');
  });

  it('refuses a key file with a second hard link', () => {
    writeFakeKey(dir, {});
    linkSync(join(dir, 'owner.key'), join(dir, 'copy'));
    expectTampered(() => loadOwnerKey(dir, PASS), 'key_file');
  });

  it('refuses a key directory open to group or other, on create and on load', () => {
    const keyDir = join(dir, 'keys');
    mkdirSync(keyDir, { mode: 0o700 });
    chmodSync(keyDir, 0o755);
    expectTampered(() => createOwnerKey(keyDir, PASS), 'key_dir');
    expectTampered(() => loadOwnerKey(keyDir, PASS), 'key_dir');
  });

  it('counts passphrase length in code points after NFKC', () => {
    // 10 × (e + combining acute) is 20 code points, but NFKC composes it to 10.
    expectKind(
      () => createOwnerKey(dir, 'e\u0301'.repeat(10)),
      'passphrase_too_short',
    );
  });

  it(
    'reports a wrong passphrase as key_unlock_failed',
    { timeout: SLOW },
    () => {
      createOwnerKey(dir, PASS);
      expectKind(
        () => loadOwnerKey(dir, 'another long passphrase'),
        'key_unlock_failed',
      );
    },
  );

  it('refuses a key directory inside a git repository', () => {
    gitInit(dir);
    const keyDir = join(dir, 'keys');
    mkdirSync(keyDir);
    expectKind(() => createOwnerKey(keyDir, PASS), 'trust_tampered');
  });
});

describe('store pins the owner key', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowctl-pin-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeStore = (doc: Record<string, unknown>, key?: OwnerKey): void => {
    rawStore(dir, doc, key);
  };

  it(
    'accepts an entry signed by the pinned key and refuses a forged one',
    () => {
      const key = createOwnerKey(join(dir, 'keys'), PASS);
      writeStore(
        {
          v: 1,
          markers: ['test'],
          ownerFingerprint: key.fingerprint,
          ownerPublicKey: key.publicKey.toString('base64'),
        },
        key,
      );
      const store = TrustStore.open(dir);
      const entry = { id: 'checkout', kind: 'hooks', value: { digest: 'abc' } };
      expect(() =>
        store.assertSigned(entry, key.signEntry(entry)),
      ).not.toThrow();
      try {
        store.assertSigned(
          { ...entry, value: { digest: 'evil' } },
          key.signEntry(entry),
        );
        throw new Error('expected trust_tampered');
      } catch (e) {
        expect(e).toBeInstanceOf(TrustError);
        if (e instanceof TrustError) {
          expect(e.kind).toBe('trust_tampered');
          expect(e.detail).toBe('bad_signature');
        }
      }
    },
    SLOW,
  );

  it('refuses a pinned public key that does not match the fingerprint', () => {
    writeStore({
      v: 1,
      markers: ['test'],
      ownerFingerprint: '0'.repeat(64),
      ownerPublicKey: Buffer.alloc(32, 7).toString('base64'),
    });
    try {
      TrustStore.open(dir);
      throw new Error('expected trust_tampered');
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.detail).toBe('owner_key_mismatch');
    }
  });

  it.each([
    [
      'only the public key',
      { ownerPublicKey: Buffer.alloc(32, 7).toString('base64') },
    ],
    ['only the fingerprint', { ownerFingerprint: 'a'.repeat(64) }],
  ])('refuses a store that pins %s', (_name, pin) => {
    writeStore({ v: 1, markers: ['test'], ...pin });
    try {
      TrustStore.open(dir);
      throw new Error('expected trust_tampered');
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.detail).toBe('owner_key_mismatch');
    }
  });

  it('refuses every signed entry when the store pins no key', () => {
    writeStore({ v: 1, markers: ['test'] });
    try {
      TrustStore.open(dir).assertSigned(
        { id: 'x', kind: 'hooks', value: 1 },
        'AAAA',
      );
      throw new Error('expected trust_tampered');
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.detail).toBe('no_owner_key');
    }
  });
});
