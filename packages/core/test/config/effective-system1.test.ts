import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig, RunError, type LoadedConfig } from '../../src/index.js';
import { effectiveConfig } from '../../src/config/index.js';
import { System1Client } from '../../src/system1/index.js';
import { addSystem1, requireTrust, TrustStore } from '../../src/trust/index.js';
import { testOwnerKey, testStore } from '../trust-fixture.js';

const BASE = {
  defaultEnv: 'local',
  envs: {
    local: { baseUrl: 'http://127.0.0.1:4200' },
    staging: { baseUrl: 'http://127.0.0.1:4300' },
  },
  profiles: { admin: {} },
  system1: {
    baseUrl: 'https://api.typesafe.ai',
    allowedEnvs: ['local', 'staging'],
  },
};

/** A store made from `BASE` with `system1` allowing `api.typesafe.ai:443`, `TYPESAFE_API_KEY` and env `local`. */
function store(): { store: TrustStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-s1-'));
  mkdirSync(join(root, '.flows'));
  const s = testStore(parseConfig(BASE, root));
  addSystem1(s, testOwnerKey(), {
    host: 'api.typesafe.ai:443',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    envs: ['local'],
  });
  return { store: TrustStore.open(s.dir), root };
}

function effective(
  s: TrustStore,
  root: string,
  repo: Record<string, unknown>,
): { cfg: LoadedConfig; warnings: string[] } {
  const cfg = parseConfig(repo, root);
  return effectiveConfig(
    cfg,
    requireTrust(s, { projectDir: cfg.root, flowsDir: cfg.flowsPath }),
  );
}

const refusal = (cfg: LoadedConfig, env: string): string | undefined => {
  try {
    System1Client.fromConfig(cfg, env, {
      TYPESAFE_API_KEY: 'k',
      OTHER_KEY: 'k',
    });
  } catch (e) {
    if (e instanceof RunError) return e.kind;
    throw e;
  }
  return undefined;
};

describe('system1 rows of the per-key matrix (ADR 0024 section 1)', () => {
  it('keeps a repo config inside the section as it is', () => {
    const { store: s, root } = store();
    const { cfg } = effective(s, root, BASE);
    expect(cfg.system1?.allowedEnvs).toEqual(['local']);
    expect(refusal(cfg, 'local')).toBeUndefined();
  });

  it('system1.allowedEnvs: an env outside the section is dropped with a warning', () => {
    const { store: s, root } = store();
    const { cfg, warnings } = effective(s, root, BASE);
    expect(refusal(cfg, 'staging')).toBe('system1_not_allowed');
    expect(warnings.join('\n')).toContain('does not allow for System 1');
  });

  it('system1.baseUrl: another host turns System 1 off', () => {
    const { store: s, root } = store();
    const { cfg } = effective(s, root, {
      ...BASE,
      system1: { ...BASE.system1, baseUrl: 'https://evil.example' },
    });
    expect(refusal(cfg, 'local')).toBe('system1_not_allowed');
  });

  it('system1.baseUrl: another port, or plain http on the allowed port, turns System 1 off', () => {
    const { store: s, root } = store();
    for (const baseUrl of [
      'https://api.typesafe.ai:8443',
      'http://api.typesafe.ai:443',
    ]) {
      const { cfg } = effective(s, root, {
        ...BASE,
        system1: { ...BASE.system1, baseUrl },
      });
      expect(refusal(cfg, 'local'), baseUrl).toBe('system1_not_allowed');
    }
  });

  it('system1.baseUrl: case and an explicit default port are the same host', () => {
    const { store: s, root } = store();
    const { cfg } = effective(s, root, {
      ...BASE,
      system1: { ...BASE.system1, baseUrl: 'https://API.TypeSafe.ai:443/x' },
    });
    expect(refusal(cfg, 'local')).toBeUndefined();
  });

  it('system1.apiKeyEnv: another variable turns System 1 off', () => {
    const { store: s, root } = store();
    const { cfg } = effective(s, root, {
      ...BASE,
      system1: { ...BASE.system1, apiKeyEnv: 'OTHER_KEY' },
    });
    expect(refusal(cfg, 'local')).toBe('system1_not_allowed');
  });
});
