import { gitInit, rawStore, testOwnerKey } from './trust-fixture.js';
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultStoreDir, TrustError, TrustStore } from '../src/trust/index.js';

/**
 * C1 of T1.0: the store's read + validate path, with no interactive commands.
 * The store is opened through the test-only `TrustStore.open(dir)` seam (ADR 0025 section 1);
 * these tests build a `test`-marked store in a temp dir.
 */
describe('trust store location', () => {
  it('resolves the default dir from the passwd home, taking no environment input', () => {
    // The function takes no env parameter at all: the passwd home is the only source
    // (ADR 0025 section 1), so no variable can change where the store is looked for.
    const resolved = defaultStoreDir();
    expect(resolved.endsWith('/.config/flowctl')).toBe(true);
    expect(defaultStoreDir()).toBe(resolved);
  });
});

describe('trust store open + validate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'flowctl-store-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const writeStore = (store: Record<string, unknown>): void => {
    rawStore(dir, store);
  };

  it('opens a minimal valid test store', () => {
    writeStore({
      v: 1,
      markers: ['test'],
      ownerFingerprint: testOwnerKey().fingerprint,
      ownerPublicKey: testOwnerKey().publicKey.toString('base64'),
      projects: {},
      envs: {},
      profiles: {},
      roots: [],
    });
    const store = TrustStore.open(dir);
    expect(store.isTest).toBe(true);
    expect(store.isCi).toBe(false);
  });

  it('refuses a store inside a git repository', () => {
    gitInit(dir);
    writeStore({
      v: 1,
      markers: ['test'],
      projects: {},
      envs: {},
      profiles: {},
      roots: [],
    });
    expect(() => TrustStore.open(dir)).toThrow(TrustError);
    try {
      TrustStore.open(dir);
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.kind).toBe('trust_tampered');
    }
  });

  it('reports trust_missing when there is no store file', () => {
    try {
      TrustStore.open(dir);
      throw new Error('expected open to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.kind).toBe('trust_missing');
    }
  });

  it('refuses an invalid store shape', () => {
    writeStore({ v: 1, markers: ['test'], projects: 'not an object' });
    expect(() => TrustStore.open(dir)).toThrow(TrustError);
  });

  it('refuses an unknown top-level key (strict schema)', () => {
    writeStore({
      v: 1,
      markers: ['test'],
      projects: {},
      envs: {},
      profiles: {},
      roots: [],
      somethingUnexpected: true,
    });
    try {
      TrustStore.open(dir);
      throw new Error('expected open to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(TrustError);
      if (e instanceof TrustError) expect(e.kind).toBe('trust_entry_invalid');
    }
  });

  it('refuses a world- or group-writable store file', () => {
    writeStore({
      v: 1,
      markers: ['test'],
      projects: {},
      envs: {},
      profiles: {},
      roots: [],
    });
    chmodSync(join(dir, 'trust.json'), 0o660);
    expectTrustTampered(dir);
  });

  it('refuses a store file that is a symlink', () => {
    const real = join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ v: 1, markers: ['test'] }), {
      mode: 0o600,
    });
    symlinkSync(real, join(dir, 'trust.json'));
    expectTrustTampered(dir);
  });

  it('refuses a store file with more than one hard link', () => {
    writeStore({
      v: 1,
      markers: ['test'],
      projects: {},
      envs: {},
      profiles: {},
      roots: [],
    });
    linkSync(join(dir, 'trust.json'), join(dir, 'second-name.json'));
    expectTrustTampered(dir);
  });

  it('refuses a store inside a subdirectory of a git repository (ancestor walk)', () => {
    gitInit(dir);
    const sub = join(dir, 'nested', 'store');
    mkdirSync(sub, { recursive: true });
    writeFileSync(
      join(sub, 'trust.json'),
      JSON.stringify({ v: 1, markers: ['test'] }),
      {
        mode: 0o600,
      },
    );
    expectTrustTampered(sub);
  });
});

function expectTrustTampered(dir: string): void {
  try {
    TrustStore.open(dir);
    throw new Error('expected open to throw TrustError');
  } catch (e) {
    expect(e).toBeInstanceOf(TrustError);
    if (e instanceof TrustError) expect(e.kind).toBe('trust_tampered');
  }
}
