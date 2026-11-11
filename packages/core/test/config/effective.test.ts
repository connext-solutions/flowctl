import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type LoadedConfig,
  parseConfig,
  resolveEnv,
  RunError,
} from '../../src/index.js';
import { CEILINGS, effectiveConfig } from '../../src/config/index.js';
import { System1Client } from '../../src/system1/index.js';
import { requireTrust } from '../../src/trust/index.js';
import { testStore } from '../trust-fixture.js';

const ROOT = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-effective-'));
  mkdirSync(join(root, '.flows'));
  return root;
};

const BASE = {
  defaultEnv: 'local',
  envs: {
    local: { baseUrl: 'http://127.0.0.1:4200', loginUrl: '/login' },
    staging: { baseUrl: 'http://127.0.0.1:4300' },
  },
  profiles: { admin: {} },
  system1: { baseUrl: 'http://127.0.0.1:9', allowedEnvs: ['local'] },
};

/**
 * The effective config of `repo` against a store made from `BASE` at `trust init` (both envs classed `local`, default
 * env `local`), so `repo` plays the pull request that edits the file afterwards.
 */
function effective(repo: Record<string, unknown>): {
  cfg: LoadedConfig;
  warnings: string[];
} {
  const root = ROOT();
  const store = testStore(parseConfig(BASE, root));
  const cfg = parseConfig(repo, root);
  return effectiveConfig(
    cfg,
    requireTrust(store, { projectDir: cfg.root, flowsDir: cfg.flowsPath }),
  );
}

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof RunError) return e.kind;
    throw e;
  }
  return undefined;
};

describe('effective configuration, per-key matrix (ADR 0024 section 1)', () => {
  it('keeps a config that matches the store as it is, with no warning', () => {
    const { cfg, warnings } = effective(BASE);
    expect(warnings).toEqual([]);
    expect(resolveEnv(cfg).name).toBe('local');
    expect(resolveEnv(cfg, 'staging').baseUrl).toBe('http://127.0.0.1:4300');
  });

  it('envs.<n>.baseUrl and loginUrl: another origin refuses that env', () => {
    const { cfg } = effective({
      ...BASE,
      envs: {
        local: { baseUrl: 'http://127.0.0.1:5000' },
        staging: {
          baseUrl: 'http://127.0.0.1:4300',
          loginUrl: 'https://login.example.com/sso',
        },
      },
    });
    expect(kindOf(() => resolveEnv(cfg, 'local'))).toBe('env_not_trusted');
    expect(kindOf(() => resolveEnv(cfg, 'staging'))).toBe('env_not_trusted');
  });

  it.each([
    ['//evil.example/login'],
    ['/\\evil.example/login'],
    ['\\\\evil.example/login'],
    [' //evil.example'],
  ])(
    'loginUrl %j resolves to another origin, so the env is refused',
    (loginUrl) => {
      const { cfg } = effective({
        ...BASE,
        envs: { ...BASE.envs, local: { ...BASE.envs.local, loginUrl } },
      });
      expect(kindOf(() => resolveEnv(cfg, 'local'))).toBe('env_not_trusted');
    },
  );

  it('loginUrl as a path on the env origin is kept', () => {
    const { cfg } = effective(BASE);
    expect(resolveEnv(cfg, 'local').loginUrl).toBe('/login');
  });

  it('records a scope for each trusted env only, from the store origins', () => {
    const { cfg } = effective({
      ...BASE,
      envs: { ...BASE.envs, qa: { baseUrl: 'http://127.0.0.1:4400' } },
      target: { scope: { visit: ['http://127.0.0.1:4200'] } },
    });
    expect(cfg.trustView?.scopes).toEqual({
      local: {
        visit: ['http://127.0.0.1:4200'],
        call: ['http://127.0.0.1:4200'],
      },
      staging: { visit: [], call: ['http://127.0.0.1:4300'] },
    });
    expect(cfg.target.scope.visit).toEqual(['http://127.0.0.1:4200']);
  });

  it('an env the store does not know is refused; the others still run', () => {
    const { cfg } = effective({
      ...BASE,
      envs: { ...BASE.envs, qa: { baseUrl: 'http://127.0.0.1:4400' } },
    });
    expect(kindOf(() => resolveEnv(cfg, 'qa'))).toBe('env_not_trusted');
    expect(resolveEnv(cfg, 'local').name).toBe('local');
  });

  it('defaultEnv: another repo value is ignored with a warning, the recorded one is used', () => {
    const { cfg, warnings } = effective({ ...BASE, defaultEnv: 'staging' });
    expect(cfg.defaultEnv).toBe('local');
    expect(resolveEnv(cfg).name).toBe('local');
    expect(warnings.join('\n')).toContain('defaultEnv "staging"');
  });

  it('defaultEnv: a recorded default the config no longer has needs --env', () => {
    const { cfg } = effective({
      ...BASE,
      defaultEnv: 'staging',
      envs: { staging: BASE.envs.staging },
    });
    expect(kindOf(() => resolveEnv(cfg))).toBe('env_not_trusted');
    expect(resolveEnv(cfg, 'staging').name).toBe('staging');
  });

  it('envs.<n>.vars: a var holding a URL is never used as an origin', () => {
    const { cfg } = effective({
      ...BASE,
      envs: {
        ...BASE.envs,
        local: { ...BASE.envs.local, vars: { api: 'https://evil.example' } },
      },
    });
    expect(new URL(resolveEnv(cfg, 'local').baseUrl).origin).toBe(
      'http://127.0.0.1:4200',
    );
  });

  it('system1.allowedEnvs: an env the store does not trust is dropped with a warning', () => {
    const { cfg, warnings } = effective({
      ...BASE,
      envs: { ...BASE.envs, qa: { baseUrl: 'http://127.0.0.1:4400' } },
      system1: { ...BASE.system1, allowedEnvs: ['local', 'qa'] },
    });
    expect(cfg.system1?.allowedEnvs).toEqual(['local']);
    expect(warnings.join('\n')).toContain('system1.allowedEnvs lists qa');
    expect(() =>
      System1Client.fromConfig(cfg, 'qa', { TYPESAFE_API_KEY: 'k' }),
    ).toThrow(RunError);
  });

  it('system1.confidenceThreshold: may only be raised', () => {
    const lower = effective({
      ...BASE,
      system1: { ...BASE.system1, confidenceThreshold: 0.1 },
    });
    expect(lower.cfg.system1?.confidenceThreshold).toBe(0.5);
    expect(lower.warnings.join('\n')).toContain('confidenceThreshold 0.1');
    const higher = effective({
      ...BASE,
      system1: { ...BASE.system1, confidenceThreshold: 0.8 },
    });
    expect(higher.cfg.system1?.confidenceThreshold).toBe(0.8);
    expect(higher.warnings).toEqual([]);
  });

  it('maxSteps, runsRetention and timeouts: a larger value is capped, a smaller one kept', () => {
    const big = effective({
      ...BASE,
      maxSteps: 500,
      runsRetention: 5_000,
      assertTimeout: 3_600_000,
      stepTimeout: 3_600_000,
      navigationTimeout: 3_600_000,
      hookTimeout: 3_600_000,
    });
    expect(big.cfg).toMatchObject(CEILINGS);
    expect(big.warnings).toHaveLength(Object.keys(CEILINGS).length);
    const small = effective({ ...BASE, maxSteps: 30, hookTimeout: 1_000 });
    expect(small.cfg.maxSteps).toBe(30);
    expect(small.cfg.hookTimeout).toBe(1_000);
    expect(small.warnings).toEqual([]);
  });

  it('testIdAttribute: a name that breaks the pattern is refused at load', () => {
    expect(() =>
      parseConfig({ ...BASE, testIdAttribute: 'data-x"]' }, ROOT()),
    ).toThrow(/testIdAttribute/);
  });
});
