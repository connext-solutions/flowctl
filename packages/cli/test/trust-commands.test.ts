import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { loadConfig, type TrustStore } from '@flowctl/core';
import { testStore } from '@flowctl/core-testing';
import { runCli } from '../src/main.js';

/**
 * Trust commands that refuse before any prompt or have no terminal to prompt on (ADR 0025 section 3). They start no
 * browser, so they run in the unit tier.
 */
let err: string[];
let file: string;
let store: TrustStore;
beforeEach(() => {
  err = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const root = mkdtempSync(join(tmpdir(), 'flowctl-cli-trust-'));
  mkdirSync(join(root, '.flows'));
  file = join(root, 'flowctl.config.yaml');
  writeFileSync(
    file,
    stringify({
      defaultEnv: 'local',
      envs: { local: { baseUrl: 'http://127.0.0.1:9' } },
      profiles: { manager: {} },
    }),
  );
  store = testStore(loadConfig(file));
});
afterEach(() => vi.restoreAllMocks());

const run = (argv: string[]): Promise<number> =>
  runCli([...argv, '--config', file], { openStore: () => store });

describe('flowctl trust commands without a terminal', () => {
  it.each([
    [['api.typesafe.ai', 'TYPESAFE_API_KEY', 'local'], 3, 'is not host:port'],
    [['api.typesafe.ai:443', 'TYPESAFE_API_KEY'], 2, 'Usage'],
    [['api.typesafe.ai:443', 'TYPESAFE_API_KEY', 'local'], 3, 'tty_required'],
  ])(
    'trust add system1 %j exits %d with %s (T1.1)',
    async (args, code, says) => {
      expect(await run(['trust', 'add', 'system1', ...args])).toBe(code);
      expect(err.join('')).toContain(says);
    },
  );

  it.each([
    [['local', 'nowhere', 'https://api.example.com'], 'is not visit or call'],
    [['local', 'call', 'https://api.example.com/v1'], 'is not an origin'],
    [['local', 'call', 'https://api.example.com'], 'tty_required'],
  ])('trust add origin %j exits 3 with %s (T1.2)', async (args, says) => {
    expect(await run(['trust', 'add', 'origin', ...args])).toBe(3);
    expect(err.join('')).toContain(says);
  });

  it.each([
    [['trust', 'key', 'rotate-owner']],
    [['trust', 'init', '--replace']],
  ])('%j exits 3 with tty_required (T1.0)', async (argv) => {
    expect(await run(argv)).toBe(3);
    expect(err.join('')).toContain('tty_required');
  });
});
