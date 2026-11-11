import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ConfigError,
  findConfig,
  loadConfig,
  parseConfig,
  resolveEnv,
  runsPath,
  storageStatePath,
} from '../src/config.js';

const minimal = {
  defaultEnv: 'local',
  envs: { local: { baseUrl: 'http://localhost:4200' } },
  profiles: { admin: {} },
};

describe('config', () => {
  it('applies defaults', () => {
    const c = parseConfig(minimal, '/repo');
    expect(c.flowsPath).toBe('/repo/.flows');
    expect(c.testIdAttribute).toBe('data-testid');
    expect(c.assertTimeout).toBe(10_000);
    expect(c.stepTimeout).toBe(5_000);
    expect(c.navigationTimeout).toBe(30_000);
    expect(c.runsRetention).toBe(20);
    expect(c.profiles.admin?.locale).toBe('vi-VN');
    expect(c.system1).toBeUndefined();
  });

  it('fills system1 defaults when the block is present', () => {
    const c = parseConfig(
      { ...minimal, system1: { baseUrl: 'https://api.typesafe.ai' } },
      '/repo',
    );
    expect(c.system1).toEqual({
      baseUrl: 'https://api.typesafe.ai',
      apiKeyEnv: 'TYPESAFE_API_KEY',
      model: 'jev-latest',
      confidenceThreshold: 0.5,
      allowedEnvs: ['local', 'staging'],
    });
  });

  it('rejects a defaultEnv that is not a key of envs', () => {
    expect(() =>
      parseConfig({ ...minimal, defaultEnv: 'staging' }, '/repo'),
    ).toThrow(/defaultEnv/);
  });

  it('rejects unknown keys', () => {
    expect(() => parseConfig({ ...minimal, flowDir: 'x' }, '/repo')).toThrow(
      ConfigError,
    );
  });

  it('finds the config upward and resolves flowsDir relative to it', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowctl-cfg-'));
    writeFileSync(
      join(root, 'flowctl.config.yaml'),
      'defaultEnv: local\nenvs:\n  local: { baseUrl: "http://localhost:4200" }\nprofiles:\n  admin: {}\nflowsDir: ../qa/flows\n',
    );
    const deep = join(root, 'a', 'b');
    mkdirSync(deep, { recursive: true });
    expect(findConfig(deep)).toBe(join(root, 'flowctl.config.yaml'));
    expect(loadConfig(undefined, deep).flowsPath).toBe(
      join(root, '..', 'qa', 'flows'),
    );
  });

  it('explains how to fix a missing config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-none-'));
    expect(() => loadConfig(undefined, dir)).toThrow(/--config/);
  });

  it('resolves envs and derived paths', () => {
    const c = parseConfig(minimal, '/repo');
    expect(resolveEnv(c)).toEqual({
      name: 'local',
      baseUrl: 'http://localhost:4200',
      vars: {},
    });
    expect(() => resolveEnv(c, 'prod')).toThrow(/Unknown env "prod"/);
    expect(storageStatePath(c, 'local', 'admin')).toBe(
      '/repo/.flows/.auth/local/admin.json',
    );
    expect(runsPath(c)).toBe('/repo/.flows/.runs');
  });
});

describe('config names (#17)', () => {
  it('rejects env and profile names that are not lowercase-dash names', () => {
    expect(() =>
      parseConfig({ ...minimal, profiles: { '../../tmp/x': {} } }, '/repo'),
    ).toThrow(ConfigError);
    expect(() =>
      parseConfig(
        {
          ...minimal,
          defaultEnv: 'Staging',
          envs: { Staging: { baseUrl: 'http://localhost:4200' } },
        },
        '/repo',
      ),
    ).toThrow(ConfigError);
  });

  it('does not resolve prototype keys as envs', () => {
    const c = parseConfig(minimal, '/repo');
    expect(() => resolveEnv(c, 'toString')).toThrow(ConfigError);
  });
});
