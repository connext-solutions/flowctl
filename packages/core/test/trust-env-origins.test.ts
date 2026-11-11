import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { effectiveConfig } from '../src/config/index.js';
import {
  addEnvOrigin,
  addProductionOrigin,
  checkEnvOrigin,
  initTrust,
  productionHosts,
  requireTrust,
  TrustError,
  TrustStore,
  trustedEnv,
} from '../src/trust/index.js';
import { fixtureConfig } from './helpers.js';
import {
  editStore,
  gitRepo,
  testAnchorDir,
  testOwnerKey,
  testStore,
} from './trust-fixture.js';

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return e.kind;
    throw e;
  }
  return undefined;
};

const fresh = () => {
  const cfg = fixtureConfig('http://127.0.0.1:4200');
  mkdirSync(cfg.flowsPath, { recursive: true });
  return { cfg, store: testStore(cfg) };
};

describe('trust add origin (ADR 0025 section 2, envs)', () => {
  it('adds a signed call origin that the run scope then includes', () => {
    const { cfg, store } = fresh();
    addEnvOrigin(
      store,
      testOwnerKey(),
      'local',
      'call',
      'http://localhost:9000',
    );
    addEnvOrigin(
      store,
      testOwnerKey(),
      'local',
      'visit',
      'http://127.0.0.1:4300',
    );
    const after = TrustStore.open(store.dir);
    expect(trustedEnv(after, 'local')).toMatchObject({
      callOrigins: ['http://localhost:9000'],
      visitOrigins: ['http://127.0.0.1:4300'],
    });
    const eff = effectiveConfig(
      cfg,
      requireTrust(after, { projectDir: cfg.root, flowsDir: cfg.flowsPath }),
    ).cfg;
    expect(eff.trustView?.scopes?.['local']).toEqual({
      visit: ['http://127.0.0.1:4200', 'http://127.0.0.1:4300'],
      call: ['http://127.0.0.1:4200', 'http://localhost:9000'],
    });
  });

  it('refuses an unknown env, a non-origin, the env origin, a duplicate, http off the private network and a production host', () => {
    const { store } = fresh();
    const check = (env: string, origin: string) => () =>
      checkEnvOrigin(store, env, 'call', origin);
    expect(kindOf(check('nope', 'https://api.example.com'))).toBe(
      'trust_entry_invalid',
    );
    for (const bad of [
      'https://api.example.com/v1',
      'api.example.com',
      'http://127.0.0.1:4200',
      'http://api.example.com',
    ])
      expect(kindOf(check('local', bad)), bad).toBe('trust_entry_invalid');
    addEnvOrigin(
      store,
      testOwnerKey(),
      'local',
      'call',
      'https://api.example.com',
    );
    const after = TrustStore.open(store.dir);
    expect(
      kindOf(() =>
        checkEnvOrigin(after, 'local', 'call', 'https://api.example.com'),
      ),
    ).toBe('trust_entry_invalid');
    addProductionOrigin(after, testOwnerKey(), 'https://erp.example.com');
    expect(
      kindOf(() =>
        checkEnvOrigin(
          TrustStore.open(store.dir),
          'local',
          'visit',
          'https://erp.example.com:8443',
        ),
      ),
    ).toBe('trust_entry_invalid');
  });

  it("refuses a production env's origin, which is a production host even with no production origin listed", () => {
    const cfg = fixtureConfig('http://127.0.0.1:4200');
    mkdirSync(cfg.flowsPath, { recursive: true });
    gitRepo(cfg.root);
    const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-store-')), 's');
    initTrust({
      storeDir: dir,
      key: testOwnerKey(),
      project: 'test-project',
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      answers: {
        envs: {
          local: { origin: 'http://127.0.0.1:4200', class: 'local' },
          prod: { origin: 'https://erp.example.com', class: 'production' },
        },
        productionOrigins: [],
        defaultEnv: 'local',
        language: 'vi',
        locale: 'vi-VN',
      },
      anchorDir: testAnchorDir(),
    });
    const store = TrustStore.open(dir);
    expect(productionHosts(store)).toEqual(['erp.example.com']);
    expect(
      kindOf(() =>
        checkEnvOrigin(store, 'local', 'call', 'https://erp.example.com:8443'),
      ),
    ).toBe('trust_entry_invalid');
    expect(
      kindOf(() =>
        checkEnvOrigin(store, 'prod', 'call', 'https://api.example.com'),
      ),
    ).toBe('trust_entry_invalid');
  });

  it('refuses an env entry that is not owner-signed, and a ci store', () => {
    const { store } = fresh();
    editStore(store.dir, (d) => {
      const e = d.envs['local'];
      if (e !== undefined) e.callOrigins = ['https://evil.example'];
      return d;
    });
    expect(
      kindOf(() =>
        checkEnvOrigin(
          TrustStore.open(store.dir),
          'local',
          'call',
          'https://a.example',
        ),
      ),
    ).toBe('trust_tampered');
    const other = fresh().store;
    editStore(other.dir, (d) => ({ ...d, markers: ['ci'] }));
    expect(
      kindOf(() =>
        checkEnvOrigin(
          TrustStore.open(other.dir),
          'local',
          'call',
          'https://a.example',
        ),
      ),
    ).toBe('trust_entry_invalid');
  });
});
