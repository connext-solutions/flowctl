import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureConfig } from './helpers.js';
import {
  TrustError,
  TrustStore,
  addProductionOrigin,
  addTrustedEnv,
  createOwnerKey,
  isProductionOrigin,
  setProjectSetting,
} from '../src/trust/index.js';
import { signEnv, signProductionOrigin } from '../src/trust/init.js';
import { rawStore, testOwnerKey, testStore } from './trust-fixture.js';

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return e.kind;
    throw e;
  }
  return undefined;
};

const fresh = (): TrustStore => {
  const cfg = fixtureConfig('http://127.0.0.1:1');
  mkdirSync(cfg.flowsPath, { recursive: true });
  return testStore(cfg);
};

describe('trust add default-env | language | locale (ADR 0025 section 3)', () => {
  it('changes one setting, keeps the others, and signs the project entry again', () => {
    const store = fresh();
    const before = store.data.projects['test-project'];
    setProjectSetting(store, testOwnerKey(), 'test-project', {
      field: 'locale',
      value: 'en-US',
    });
    const after = TrustStore.open(store.dir);
    expect(after.data.projects['test-project']).toMatchObject({
      locale: 'en-US',
      language: before?.language,
      defaultEnv: before?.defaultEnv,
      identity: before?.identity,
    });
    setProjectSetting(after, testOwnerKey(), 'test-project', {
      field: 'language',
      value: 'en',
    });
    expect(
      TrustStore.open(store.dir).data.projects['test-project']?.language,
    ).toBe('en');
  });

  it('refuses a default env the store does not class, a production env, bad codes and an unknown project', () => {
    const store = fresh();
    const key = testOwnerKey();
    expect(
      kindOf(() =>
        setProjectSetting(store, key, 'test-project', {
          field: 'defaultEnv',
          value: 'nope',
        }),
      ),
    ).toBe('trust_entry_invalid');
    for (const [field, value] of [
      ['language', 'Vietnamese'],
      ['locale', 'vi_VN'],
    ] as const)
      expect(
        kindOf(() =>
          setProjectSetting(store, key, 'test-project', { field, value }),
        ),
      ).toBe('trust_entry_invalid');
    expect(
      kindOf(() =>
        setProjectSetting(store, key, 'other', {
          field: 'locale',
          value: 'vi-VN',
        }),
      ),
    ).toBe('trust_entry_invalid');
  });
});

describe('trust add production-origin', () => {
  it('adds a signed production origin and refuses a duplicate or a non-origin', () => {
    const store = fresh();
    addProductionOrigin(store, testOwnerKey(), 'https://erp.example.com');
    const after = TrustStore.open(store.dir);
    expect(isProductionOrigin(after, 'https://erp.example.com')).toBe(true);
    for (const o of ['https://erp.example.com', 'https://erp.example.com/x'])
      expect(kindOf(() => addProductionOrigin(after, testOwnerKey(), o))).toBe(
        'trust_entry_invalid',
      );
  });

  it('refuses an origin an env already uses with a lower class', () => {
    const store = fresh();
    expect(
      kindOf(() =>
        addProductionOrigin(store, testOwnerKey(), 'http://127.0.0.1:1'),
      ),
    ).toBe('trust_entry_invalid');
  });
});

describe('per-project settings: real changes and every refusal', () => {
  it('sets the default env to a second env the owner classed, and refuses setting it again', () => {
    const store = fresh();
    addTrustedEnv(store, testOwnerKey(), 'local2', {
      origin: 'http://127.0.0.1:2',
      class: 'local',
    });
    const withTwo = TrustStore.open(store.dir);
    setProjectSetting(withTwo, testOwnerKey(), 'test-project', {
      field: 'defaultEnv',
      value: 'local2',
    });
    const after = TrustStore.open(store.dir);
    expect(after.data.projects['test-project']?.defaultEnv).toBe('local2');
    expect(
      kindOf(() =>
        setProjectSetting(after, testOwnerKey(), 'test-project', {
          field: 'defaultEnv',
          value: 'local2',
        }),
      ),
    ).toBe('trust_entry_invalid');
  });

  /** A non-test store with a production env and a shared env on the production host, written by hand. */
  const prodStore = (markers: string[] = []): TrustStore => {
    const key = testOwnerKey();
    const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-settings-')), 'store');
    const project = { root: '/nonexistent/p', identity: ['a'.repeat(40)] };
    rawStore(dir, {
      v: 1,
      markers,
      ownerFingerprint: key.fingerprint,
      ownerPublicKey: key.publicKey.toString('base64'),
      projects: {
        p: {
          ...project,
          sig: key.signEntry({ id: 'p', kind: 'projects', value: project }),
        },
      },
      envs: {
        prod: signEnv(key, 'prod', {
          origin: 'https://erp.example.com',
          class: 'production',
        }),
        stg: signEnv(key, 'stg', {
          origin: 'https://stg.example.com',
          class: 'shared',
        }),
        side: signEnv(key, 'side', {
          origin: 'http://erp.example.com:8080',
          class: 'shared',
        }),
      },
      productionOrigins: {
        'https://erp.example.com': signProductionOrigin(
          key,
          'https://erp.example.com',
        ),
      },
    });
    return TrustStore.open(dir);
  };

  it('refuses a production env, and an env on a production host, as the default env', () => {
    const store = prodStore();
    for (const value of ['prod', 'side'])
      expect(
        kindOf(() =>
          setProjectSetting(store, testOwnerKey(), 'p', {
            field: 'defaultEnv',
            value,
          }),
        ),
      ).toBe('trust_entry_invalid');
    setProjectSetting(store, testOwnerKey(), 'p', {
      field: 'defaultEnv',
      value: 'stg',
    });
  });

  it('refuses a production origin whose host is covered, or holds an env classed lower', () => {
    const store = prodStore();
    expect(
      kindOf(() =>
        addProductionOrigin(
          store,
          testOwnerKey(),
          'https://erp.example.com:8443',
        ),
      ),
    ).toBe('trust_entry_invalid');
    expect(
      kindOf(() =>
        addProductionOrigin(
          store,
          testOwnerKey(),
          'https://stg.example.com:9443',
        ),
      ),
    ).toBe('trust_entry_invalid');
  });

  it('refuses both kinds on a ci store, and a key that is not the pinned one', () => {
    const ci = prodStore(['ci']);
    expect(
      kindOf(() =>
        setProjectSetting(ci, testOwnerKey(), 'p', {
          field: 'locale',
          value: 'en-US',
        }),
      ),
    ).toBe('trust_entry_invalid');
    expect(
      kindOf(() =>
        addProductionOrigin(ci, testOwnerKey(), 'https://new.example.com'),
      ),
    ).toBe('trust_entry_invalid');
    const other = createOwnerKey(
      join(mkdtempSync(join(tmpdir(), 'flowctl-otherkey-')), 'k'),
      'another long passphrase here',
    );
    expect(
      kindOf(() =>
        setProjectSetting(prodStore(), other, 'p', {
          field: 'locale',
          value: 'en-US',
        }),
      ),
    ).toBe('trust_tampered');
  });
});
