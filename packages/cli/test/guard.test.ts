import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type CommandName,
  COMMANDS,
  loadConfig,
  type McpCommand,
  TrustError,
} from '@flowctl/core';
import { gitRepo, testStore } from '@flowctl/core-testing';
import { runCli } from '../src/main.js';

/**
 * ADR 0025 section 3, "Guarded commands": every guarded command run with no store ends `trust_missing`
 * (exit 3) and has touched no file. The table is keyed by the registry, so a new guarded command without a
 * row here does not compile.
 */
type Guarded = Exclude<
  {
    [K in CommandName]: (typeof COMMANDS)[K]['guarded'] extends true
      ? K
      : never;
  }[CommandName],
  McpCommand
>;

const ARGV: Record<Guarded, string[]> = {
  replay: ['replay'],
  login: ['login', 'manager'],
  cleanup: ['cleanup', 'r_lq3k2a1b9f0e'],
  observe: ['observe'],
  'trust hook': ['trust', 'hook', 'leave-approve'],
  'trust add env': ['trust', 'add', 'env', 'local'],
  'trust add profile': [
    'trust',
    'add',
    'profile',
    'employee',
    'QA_PASSWORD',
    'secret',
  ],
  'trust add project': ['trust', 'add', 'project'],
  'trust add default-env': ['trust', 'add', 'default-env', 'local'],
  'trust add language': ['trust', 'add', 'language', 'vi'],
  'trust add locale': ['trust', 'add', 'locale', 'vi-VN'],
  'trust add production-origin': [
    'trust',
    'add',
    'production-origin',
    'https://erp.example.com',
  ],
  'trust key rotate-owner': ['trust', 'key', 'rotate-owner'],
  'trust add origin': [
    'trust',
    'add',
    'origin',
    'local',
    'call',
    'https://api.example.com',
  ],
  'trust add destructive': [
    'trust',
    'add',
    'destructive',
    'items-crud',
    '--env',
    'local',
    '--from-run',
    'r_lq3k2a1b9f0e',
  ],
  'trust revoke destructive': [
    'trust',
    'revoke',
    'destructive',
    'items-create',
  ],
  'trust add system1': [
    'trust',
    'add',
    'system1',
    'api.typesafe.ai:443',
    'TYPESAFE_API_KEY',
    'local',
  ],
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

function project(): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-guard-'));
  mkdirSync(join(root, '.flows'));
  writeFileSync(
    join(root, '.flows', 'leave-approve.yaml'),
    'name: leave-approve\ngoal: g\nprofile: manager\nstart: /\nsteps: []\nexpect: []\n',
  );
  const file = join(root, 'flowctl.config.yaml');
  writeFileSync(
    file,
    'defaultEnv: local\nenvs:\n  local: { baseUrl: "http://127.0.0.1:9", loginUrl: /login }\nprofiles:\n  manager: {}\n',
  );
  return { root, file };
}

const tree = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();

describe('guarded commands without a trust store', () => {
  it('lets trust add project past the guard with a store but no project entry, unlike replay', async () => {
    const p = project();
    gitRepo(p.root);
    const store = testStore(loadConfig(project().file));
    expect(
      await runCli(['replay', '--config', p.file], {
        openStore: () => store,
      }),
    ).toBe(3);
    expect(err.join('')).toContain('trust_missing');
    err.length = 0;
    expect(
      await runCli(['trust', 'add', 'project', '--config', p.file], {
        openStore: () => store,
      }),
    ).toBe(3);
    expect(err.join('')).toContain('tty_required');
  });

  it('lets only trust key rotate-owner past a store left mid-rotation', async () => {
    const p = project();
    const midRotation = (): never => {
      throw new TrustError('rotate_incomplete', 'a rotation did not finish');
    };
    expect(
      await runCli(['replay', '--config', p.file], { openStore: midRotation }),
    ).toBe(3);
    expect(err.join('')).toContain('rotate_incomplete');
    err.length = 0;
    expect(
      await runCli(['trust', 'key', 'rotate-owner', '--config', p.file], {
        openStore: midRotation,
      }),
    ).toBe(3);
    expect(err.join('')).toContain('tty_required');
  });
  it.each(Object.entries(ARGV))(
    '%s ends trust_missing and touches no file',
    async (_, argv) => {
      const p = project();
      const before = tree(p.root);
      expect(
        await runCli([...argv, '--config', p.file], {
          openStore: () => undefined,
        }),
      ).toBe(3);
      expect(err.join('')).toContain('trust_missing');
      expect(err.join('')).toContain('flowctl trust init');
      expect(tree(p.root)).toEqual(before);
    },
  );

  it('reports a usage error before the trust check', async () => {
    const p = project();
    expect(
      await runCli(['trust', 'add', 'env', '--config', p.file], {
        openStore: () => undefined,
      }),
    ).toBe(2);
    expect(err.join('')).not.toContain('trust_missing');
  });

  it.each([
    [['trust', 'link'], 'not available yet'],
    [['trust', 'add', 'root', 'x'], 'not available yet'],
    [['trust', 'key', 'new'], 'not available yet'],
    [['trust', 'leave-approve'], 'flowctl trust hook leave-approve'],
  ])('%j is a usage error that says %s', async (argv, says) => {
    expect(await runCli(argv, { openStore: () => undefined })).toBe(2);
    expect(err.join('')).toContain(says);
  });

  it('every guarded CLI command has a row (MCP tools are tested in packages/mcp)', () => {
    const runnable = Object.entries(COMMANDS)
      .filter(([n, c]) => c.guarded && !n.startsWith('mcp '))
      .map(([n]) => n)
      .sort();
    expect(Object.keys(ARGV).sort()).toEqual(runnable);
  });
});
