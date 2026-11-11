import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addTrustedEnv,
  COMMANDS,
  createOwnerKey,
  type InitAnswers,
  initTrust,
  isProductionOrigin,
  type OwnerKey,
  requireTrust,
  TrustError,
  TrustStore,
  trustedEnv,
  validateInit,
} from '../src/trust/index.js';
import { editStore, gitRepo, testAnchorDir } from './trust-fixture.js';

/**
 * C7 and C8 of T1.0: `trust init` writes what the owner typed, every entry signed (ADR 0025 section 3, "First
 * use", and the owner decision of 2026-11-02 to sign env entries), `trust add env`, and the guard of the
 * command registry ("Guarded commands").
 */
let base: string;
let key: OwnerKey;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'flowctl-init-'));
  key = createOwnerKey(join(base, 'keys'), 'correct horse battery staple');
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

const ANSWERS: InitAnswers = {
  envs: {
    local: { origin: 'http://localhost:4200', class: 'local' },
    stg: { origin: 'https://stg.example.com', class: 'shared' },
    prod: { origin: 'https://erp.example.com', class: 'production' },
  },
  productionOrigins: ['https://erp.example.com'],
  defaultEnv: 'stg',
  language: 'vi',
  locale: 'vi-VN',
};

let n = 0;
function project(answers: InitAnswers = ANSWERS) {
  const dir = mkdtempSync(join(base, `p${n++}-`));
  const root = join(dir, 'repo');
  const flows = join(root, '.flows');
  mkdirSync(flows, { recursive: true });
  gitRepo(root);
  const storeDir = join(dir, 'store');
  const init = () =>
    initTrust({
      storeDir,
      key,
      project: 'demo',
      projectDir: root,
      flowsDir: flows,
      answers,
      anchorDir: testAnchorDir(),
    });
  return { root, flows, storeDir, init, open: () => TrustStore.open(storeDir) };
}

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return e.kind;
    throw e;
  }
  return undefined;
};

describe('trust init answers', () => {
  it('writes the typed classes, production origins and project settings, all owner-signed', () => {
    const p = project();
    p.init();
    const store = p.open();
    expect(trustedEnv(store, 'stg')?.class).toBe('shared');
    expect(trustedEnv(store, 'prod')?.class).toBe('production');
    expect(trustedEnv(store, 'nope')).toBeUndefined();
    expect(isProductionOrigin(store, 'https://erp.example.com')).toBe(true);
    expect(isProductionOrigin(store, 'https://stg.example.com')).toBe(false);
    expect(store.data.projects['demo']).toMatchObject({
      defaultEnv: 'stg',
      language: 'vi',
      locale: 'vi-VN',
    });
    expect(
      requireTrust(store, { projectDir: p.root, flowsDir: p.flows }).project,
    ).toBe('demo');
  });

  it('keeps the class the owner typed even when the repo would call the origin local', () => {
    const p = project({
      ...ANSWERS,
      envs: {
        ...ANSWERS.envs,
        local: { origin: 'https://erp.example.com', class: 'production' },
      },
    });
    p.init();
    expect(trustedEnv(p.open(), 'local')?.class).toBe('production');
  });

  it.each([
    ['a production default env', { ...ANSWERS, defaultEnv: 'prod' }],
    ['an unclassified default env', { ...ANSWERS, defaultEnv: 'dev' }],
    [
      'one origin with two classes',
      {
        ...ANSWERS,
        envs: {
          ...ANSWERS.envs,
          stg2: { origin: 'https://stg.example.com', class: 'local' as const },
        },
      },
    ],
    [
      'a non-production env on a production origin',
      {
        ...ANSWERS,
        envs: {
          ...ANSWERS.envs,
          prod: { origin: 'https://erp.example.com', class: 'shared' as const },
        },
      },
    ],
    [
      'an origin with a path',
      {
        ...ANSWERS,
        envs: {
          ...ANSWERS.envs,
          stg: {
            origin: 'https://stg.example.com/app',
            class: 'shared' as const,
          },
        },
      },
    ],
    ['a bad language', { ...ANSWERS, language: 'Vietnamese' }],
    ['a bad locale', { ...ANSWERS, locale: 'vi_VN' }],
  ])('refuses %s and writes nothing', (_, answers: InitAnswers) => {
    const p = project(answers);
    expect(kindOf(p.init)).toBe('trust_entry_invalid');
    expect(kindOf(p.open)).toBe('trust_missing');
  });

  it('refuses an env entry that was edited outside flowctl', () => {
    const p = project();
    p.init();
    const file = join(p.storeDir, 'trust.json');
    const doc = JSON.parse(readFileSync(file, 'utf8')) as {
      envs: Record<string, { class: string }>;
    };
    const prod = doc.envs['prod'];
    if (prod === undefined) throw new Error('no prod entry');
    prod.class = 'local';
    writeFileSync(file, JSON.stringify(doc), { mode: 0o600 });
    expect(kindOf(() => trustedEnv(p.open(), 'prod'))).toBe('trust_tampered');
  });
});

describe('trust add env', () => {
  it('adds a signed env and refuses a second one with the same name', () => {
    const p = project();
    p.init();
    addTrustedEnv(p.open(), key, 'dev', {
      origin: 'http://localhost:5173',
      class: 'local',
    });
    expect(trustedEnv(p.open(), 'dev')?.class).toBe('local');
    expect(
      kindOf(() =>
        addTrustedEnv(p.open(), key, 'dev', {
          origin: 'http://localhost:5173',
          class: 'local',
        }),
      ),
    ).toBe('trust_entry_invalid');
  });

  it('refuses a class that contradicts a production origin', () => {
    const p = project();
    p.init();
    expect(
      kindOf(() =>
        addTrustedEnv(p.open(), key, 'prod2', {
          origin: 'https://erp.example.com',
          class: 'shared',
        }),
      ),
    ).toBe('trust_entry_invalid');
  });
});

describe('validateInit', () => {
  it('refuses a missing flows directory or a bad project name before anything is written', () => {
    const p = project();
    const base0 = {
      storeDir: p.storeDir,
      project: 'demo',
      projectDir: p.root,
      flowsDir: p.flows,
      answers: ANSWERS,
    };
    expect(validateInit(base0).flows).toBe(realpathSync(p.flows));
    expect(
      kindOf(() => validateInit({ ...base0, flowsDir: join(p.root, 'nope') })),
    ).toBe('trust_entry_invalid');
    expect(kindOf(() => validateInit({ ...base0, project: 'Dự án' }))).toBe(
      'trust_entry_invalid',
    );
    expect(kindOf(p.open)).toBe('trust_missing');
  });
});

describe('a test store (ADR 0025 section 1)', () => {
  it('accepts only loopback origins of class local', () => {
    const p = project({
      ...ANSWERS,
      envs: { local: { origin: 'http://localhost:4200', class: 'local' } },
      productionOrigins: [],
      defaultEnv: 'local',
    });
    p.init();
    editStore(p.storeDir, (d) => ({ ...d, markers: ['test'] }));
    expect(
      kindOf(() =>
        addTrustedEnv(p.open(), key, 'stg', {
          origin: 'https://stg.example.com',
          class: 'local',
        }),
      ),
    ).toBe('trust_entry_invalid');
    expect(
      kindOf(() =>
        addTrustedEnv(p.open(), key, 'lab', {
          origin: 'http://127.0.0.1:9000',
          class: 'shared',
        }),
      ),
    ).toBe('trust_entry_invalid');
    addTrustedEnv(p.open(), key, 'lab', {
      origin: 'http://127.0.0.1:9000',
      class: 'local',
    });
    expect(trustedEnv(p.open(), 'lab')?.class).toBe('local');
  });
});

describe('guarded commands', () => {
  it('pins the unguarded commands exactly', () => {
    const unguarded = Object.entries(COMMANDS)
      .filter(([, c]) => !c.guarded)
      .map(([name]) => name)
      .sort();
    expect(unguarded).toEqual(['--help', 'trust init']);
  });

  it('refuses with trust_missing when the store, the project or the flows root is missing', () => {
    const p = project();
    const where = { projectDir: p.root, flowsDir: p.flows };
    expect(kindOf(() => requireTrust(undefined, where))).toBe('trust_missing');
    p.init();
    const store = p.open();
    const other = mkdtempSync(join(base, 'other-'));
    expect(
      kindOf(() =>
        requireTrust(store, { projectDir: other, flowsDir: p.flows }),
      ),
    ).toBe('trust_missing');
    expect(
      kindOf(() =>
        requireTrust(store, { projectDir: p.root, flowsDir: other }),
      ),
    ).toBe('trust_missing');
  });
});
