import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureConfig } from './helpers.js';
import {
  TrustError,
  TrustStore,
  addProfileEnvVar,
  createStoreDoc,
  replaceStoreDoc,
  type OwnerKey,
} from '../src/trust/index.js';
import { lineHash, lineText, writeLine } from '../src/trust/log.js';
import { testOwnerKey, testStore } from './trust-fixture.js';

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return `${e.kind}:${e.detail ?? ''}`;
    throw e;
  }
  return undefined;
};

const fresh = (): TrustStore => {
  const cfg = fixtureConfig('http://127.0.0.1:1');
  mkdirSync(cfg.flowsPath, { recursive: true });
  return testStore(cfg);
};

const read = (dir: string, f: string): string =>
  readFileSync(join(dir, f), 'utf8');
const write = (dir: string, f: string, text: string): void =>
  writeFileSync(join(dir, f), text, { mode: 0o600 });

/** A key whose fingerprint is that of another store's owner: not the key `store` pins. */
const stubKey = (other: TrustStore): OwnerKey => ({
  ...testOwnerKey(),
  fingerprint: `${other.data.ownerFingerprint === '0'.repeat(64) ? '1' : '0'}${'0'.repeat(63)}`,
});

const allow = (store: TrustStore, name: string): void =>
  addProfileEnvVar(store, testOwnerKey(), 'employee', { name, kind: 'secret' });

describe('trust.log (ADR 0025 section 3, "Integrity")', () => {
  it('starts with an owner-signed genesis at init and appends one line per change', () => {
    const store = fresh();
    expect(store.log.map((l) => l.kind)).toEqual(['genesis', 'write']);
    expect(statSync(join(store.dir, 'ledgers')).mode & 0o777).toBe(0o700);
    allow(store, 'QA_A');
    const after = TrustStore.open(store.dir);
    expect(after.log.map((l) => l.seq)).toEqual([0, 1, 2]);
    const last = after.log.at(-1);
    expect(last === undefined ? undefined : lineHash(last)).toBe(
      after.data.head,
    );
  });

  it('refuses a trust.json edited outside flowctl, a missing log, a missing head and a broken chain', () => {
    const store = fresh();
    const json = read(store.dir, 'trust.json');
    const log = read(store.dir, 'trust.log');
    write(
      store.dir,
      'trust.json',
      json.replace('"markers": []', '"markers": ["test"]'),
    );
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_doc_mismatch',
    );
    write(store.dir, 'trust.json', json);
    rmSync(join(store.dir, 'trust.log'));
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_missing',
    );
    write(store.dir, 'trust.log', log);
    const doc = JSON.parse(json);
    delete doc.head;
    write(store.dir, 'trust.json', JSON.stringify(doc));
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_missing',
    );
    write(store.dir, 'trust.json', json);
    write(store.dir, 'trust.log', log.replace('"seq":1', '"seq":7'));
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_chain',
    );
    write(
      store.dir,
      'trust.log',
      log.replace(/"sig":"[^"]+"/, `"sig":"${'A'.repeat(86)}=="`),
    );
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_genesis',
    );
  });

  it('accepts a write whose log line landed but whose trust.json did not, and the next write keeps it', () => {
    const store = fresh();
    const last = store.log.at(-1);
    if (last === undefined) throw new Error('no log');
    const orphan = writeLine(last, { ...store.data, markers: ['test'] });
    write(
      store.dir,
      'trust.log',
      `${read(store.dir, 'trust.log')}${lineText(orphan)}\n`,
    );
    const reopened = TrustStore.open(store.dir);
    expect(reopened.pending).toBe(1);
    allow(reopened, 'QA_B');
    const after = TrustStore.open(store.dir);
    expect(after.pending).toBe(0);
    expect(after.log.map((l) => l.seq)).toEqual([0, 1, 2, 3]);
  });

  it('refuses a write while a lock exists, even an empty or stale one, and says how to clear it', () => {
    const store = fresh();
    for (const content of [`${process.ppid}\n`, '', '999999999\n']) {
      write(store.dir, 'trust.lock', content);
      let err: unknown;
      try {
        allow(store, 'QA_C');
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({ kind: 'store_busy' });
      expect(err instanceof Error ? err.message : '').toContain(
        `delete ${join(store.dir, 'trust.lock')}`,
      );
    }
    rmSync(join(store.dir, 'trust.lock'));
    allow(store, 'QA_C');
    expect(existsSync(join(store.dir, 'trust.lock'))).toBe(false);
  });

  it('releases the lock when a write is refused inside it', () => {
    const store = fresh();
    const stale = store.data;
    allow(store, 'QA_F');
    expect(
      kindOf(() =>
        replaceStoreDoc(store.dir, { ...stale, markers: [] }, testOwnerKey()),
      ),
    ).toBe('store_busy:');
    expect(existsSync(join(store.dir, 'trust.lock'))).toBe(false);
  });

  it('refuses a head that names an older line, a log without its final newline, and a key that is not pinned', () => {
    const store = fresh();
    allow(store, 'QA_G');
    allow(TrustStore.open(store.dir), 'QA_H');
    const json = read(store.dir, 'trust.json');
    const log = read(store.dir, 'trust.log');
    const now = TrustStore.open(store.dir);
    const old = now.log[1];
    if (old === undefined) throw new Error('short log');
    write(
      store.dir,
      'trust.json',
      JSON.stringify({ ...JSON.parse(json), head: lineHash(old) }),
    );
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_head_mismatch',
    );
    write(store.dir, 'trust.json', json);
    write(store.dir, 'trust.log', log.slice(0, -1));
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:log_chain',
    );
    write(store.dir, 'trust.log', log);
    const other = fresh();
    expect(
      kindOf(() =>
        replaceStoreDoc(
          store.dir,
          TrustStore.open(store.dir).data,
          stubKey(other),
        ),
      ),
    ).toBe('trust_tampered:owner_key_mismatch');
  });

  it('refuses an init over the leftovers of a store', () => {
    const store = fresh();
    const doc = JSON.parse(read(store.dir, 'trust.json'));
    rmSync(join(store.dir, 'trust.json'));
    expect(kindOf(() => createStoreDoc(store.dir, doc, testOwnerKey()))).toBe(
      'store_exists:',
    );
  });

  it('refuses a write built from a store that changed meanwhile', () => {
    const store = fresh();
    const stale = store.data;
    allow(store, 'QA_D');
    expect(
      kindOf(() =>
        replaceStoreDoc(store.dir, { ...stale, markers: [] }, testOwnerKey()),
      ),
    ).toBe('store_busy:');
  });

  it('refuses a store without a log or a head, so nobody can turn a store into the old form', () => {
    const store = fresh();
    const json = read(store.dir, 'trust.json');
    const doc = JSON.parse(json);
    delete doc.head;
    delete doc.anchor;
    write(store.dir, 'trust.json', JSON.stringify(doc));
    rmSync(join(store.dir, 'trust.log'));
    rmSync(join(store.dir, 'ledgers'), { recursive: true });
    let err: unknown;
    try {
      TrustStore.open(store.dir);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      kind: 'trust_tampered',
      detail: 'log_missing',
    });
    expect(err instanceof Error ? err.message : '').toContain(
      'flowctl trust init',
    );
  });
});
