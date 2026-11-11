import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig } from '@flowctl/core';
import { testStore } from '@flowctl/core-testing';
import { runCli } from '../src/main.js';

const BASE = {
  defaultEnv: 'local',
  envs: {
    local: { baseUrl: 'http://127.0.0.1:9' },
    staging: { baseUrl: 'http://127.0.0.1:8' },
  },
  profiles: { manager: {} },
};

let err: string[];
beforeEach(() => {
  err = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

/** A project whose store was made from `BASE`, then its config file rewritten to `edited` (the pull request). */
function edited(edit: Record<string, unknown>): {
  file: string;
  run: (argv: string[]) => Promise<number>;
} {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-cli-effective-'));
  mkdirSync(join(root, '.flows'));
  writeFileSync(
    join(root, '.flows', 'leave-approve.yaml'),
    'name: leave-approve\ngoal: g\nprofile: manager\nstart: /\nsteps: []\nexpect: []\n',
  );
  const file = join(root, 'flowctl.config.yaml');
  writeFileSync(file, stringify(BASE));
  const store = testStore(loadConfig(file));
  writeFileSync(file, stringify({ ...BASE, ...edit }));
  return {
    file,
    run: (argv) =>
      runCli([...argv, '--config', file], { openStore: () => store }),
  };
}

describe('the CLI runs guarded commands with the effective configuration (ADR 0024 section 1)', () => {
  it('refuses an env whose baseUrl a pull request moved, before any browser starts', async () => {
    const p = edited({
      envs: { ...BASE.envs, local: { baseUrl: 'http://127.0.0.1:7' } },
    });
    expect(await p.run(['replay'])).toBe(2);
    expect(err.join('')).toContain('flowctl: env_not_trusted:');
    expect(err.join('')).toContain('trust store records http://127.0.0.1:9');
  });

  it('warns on stderr when a pull request changed defaultEnv (the recorded one is used, see the core matrix test)', async () => {
    const p = edited({ defaultEnv: 'staging' });
    expect(await p.run(['replay', '--tag', 'none'])).toBe(2);
    expect(err.join('')).toContain(
      'flowctl: warning: defaultEnv "staging" in flowctl.config.yaml differs',
    );
  });
});
