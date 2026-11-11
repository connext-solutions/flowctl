import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, resolveEnv, RunError } from '../../src/index.js';
import { effectiveConfig } from '../../src/config/index.js';
import {
  addProject,
  initTrust,
  planProject,
  requireTrust,
  TrustStore,
} from '../../src/trust/index.js';
import {
  gitRepo,
  testAnchorDir,
  testOwnerKey,
  testStore,
} from '../trust-fixture.js';

const BASE = {
  defaultEnv: 'local',
  envs: {
    local: { baseUrl: 'http://127.0.0.1:4200' },
    staging: { baseUrl: 'http://127.0.0.1:4300' },
  },
  profiles: { admin: {} },
  system1: { baseUrl: 'http://127.0.0.1:9', allowedEnvs: ['local', 'staging'] },
};

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-effective-'));
  mkdirSync(join(root, '.flows'));
  gitRepo(root);
  return root;
};

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof RunError) return e.kind;
    throw e;
  }
  return undefined;
};

describe('effective configuration against the store (ADR 0024 sections 2 and 5)', () => {
  it('treats an env on a production host as production, whatever its entry says', () => {
    const cfg = parseConfig(BASE, project());
    const storeDir = join(
      mkdtempSync(join(tmpdir(), 'flowctl-store-')),
      'store',
    );
    initTrust({
      storeDir,
      key: testOwnerKey(),
      project: 'test-project',
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      answers: {
        envs: {
          local: { origin: 'http://127.0.0.1:4200', class: 'shared' },
          staging: { origin: 'http://127.0.0.1:4300', class: 'local' },
        },
        productionOrigins: ['https://127.0.0.1'],
        defaultEnv: 'local',
        language: 'vi',
        locale: 'vi-VN',
      },
      anchorDir: testAnchorDir(),
    });
    const store = TrustStore.open(storeDir);
    const { cfg: eff, warnings } = effectiveConfig(
      cfg,
      requireTrust(store, { projectDir: cfg.root, flowsDir: cfg.flowsPath }),
    );
    expect(eff.system1?.allowedEnvs).toEqual([]);
    expect(warnings.join('\n')).toContain('lists local, staging');
    expect(kindOf(() => resolveEnv(eff))).toBe('env_not_trusted');
    expect(resolveEnv(eff, 'local').name).toBe('local');
  });

  it('a project with no recorded default env needs --env', () => {
    const first = parseConfig(BASE, project());
    const store = testStore(first);
    const second = parseConfig(BASE, project());
    addProject(
      store,
      testOwnerKey(),
      planProject(store, {
        name: 'second',
        projectDir: second.root,
        flowsDir: second.flowsPath,
      }),
    );
    const after = TrustStore.open(store.dir);
    const { cfg } = effectiveConfig(
      second,
      requireTrust(after, {
        projectDir: second.root,
        flowsDir: second.flowsPath,
      }),
    );
    expect(kindOf(() => resolveEnv(cfg))).toBe('env_not_trusted');
    expect(resolveEnv(cfg, 'staging').name).toBe('staging');
  });
});
