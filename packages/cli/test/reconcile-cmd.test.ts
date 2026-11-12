import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, type TrustStore } from '@flowctl/core';
import { gitRepo, testStore } from '@flowctl/core-testing';
import { runCli } from '../src/main.js';

/** `flowctl reconcile` (T6.6) on hand-written run directories: output, exit codes and terminal safety. */
let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
});
afterEach(() => vi.restoreAllMocks());

interface Project {
  file: string;
  runs: string;
  store: TrustStore;
}

function project(): Project {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-reconcile-'));
  mkdirSync(join(root, '.flows', '.runs'), { recursive: true });
  const file = join(root, 'flowctl.config.yaml');
  writeFileSync(
    file,
    'defaultEnv: local\nenvs:\n  local: { baseUrl: "http://127.0.0.1:9", loginUrl: /login }\nprofiles:\n  employee: {}\n',
  );
  gitRepo(root);
  return {
    file,
    runs: join(root, '.flows', '.runs'),
    store: testStore(loadConfig(file)),
  };
}

function saveRun(p: Project, runId: string, over: object = {}): void {
  mkdirSync(join(p.runs, runId));
  writeFileSync(
    join(p.runs, runId, 'run.json'),
    JSON.stringify({
      runId,
      flow: 'submit',
      env: 'local',
      status: 'failed',
      steps: 2,
      healed: [],
      teardownFailed: false,
      weakLocators: [],
      evidence: { dir: 'x', traces: [], network: [], console: [] },
      ms: 5,
      ...over,
    }),
  );
}

const reconcile = (p: Project, ...argv: string[]): Promise<number> =>
  runCli(['reconcile', ...argv, '--config', p.file], {
    openStore: () => p.store,
  });

const controls = (text: string): string[] =>
  [...text].filter((c) => {
    const n = c.codePointAt(0) ?? 0;
    return c !== '\n' && (n < 0x20 || (n >= 0x7f && n <= 0x9f));
  });

describe('flowctl reconcile <run id>', () => {
  it('prints the class, the confidence and each basis hit with its evidence, escaped, and exits 0', async () => {
    const p = project();
    saveRun(p, 'r_t1', {
      flow: 'sub\u001b]0;pwned\u0007mit',
      evidence: {
        dir: 'x',
        traces: [],
        console: [],
        network: ['503 GET http://127.0.0.1:9/api/\u001b[2J\u009b31m {}'],
      },
    });
    expect(await reconcile(p, 'r_t1')).toBe(0);
    const text = out.join('');
    expect(text).toMatch(
      /^Run r_t1 \(flow sub\\u\{001B\}\]0;pwned\\u\{0007\}mit, failed\): environment, confidence medium$/m,
    );
    expect(text).toContain('gateway-status (environment, medium):');
    expect(text).toContain('run.json /evidence/network/0: 503 GET');
    expect(text).toContain('/api/\\u{001B}[2J\\u{009B}31m');
    expect(controls(out.join(''))).toEqual([]);
    expect(controls(text)).toEqual([]);
    expect(text).toMatch(/^Classification file: .+classification\.json$/m);
  });

  it('prints the core Classification with --json, invisible characters escaped, the same object it writes to classification.json', async () => {
    const p = project();
    saveRun(p, 'r_t2', {
      evidence: {
        dir: 'x',
        traces: [],
        console: [],
        network: ['502 GET http://127.0.0.1:9/a\u009b31m\u202eb {}'],
      },
    });
    expect(await reconcile(p, 'r_t2', '--json')).toBe(0);
    expect(controls(out.join(''))).toEqual([]);
    expect(out.join('')).not.toContain('\u202e');
    const c: Record<string, unknown> = JSON.parse(out.join(''));
    expect(Object.keys(c).sort()).toEqual([
      'basis',
      'candidates',
      'class',
      'confidence',
      'hits',
      'notes',
      'runId',
    ]);
    expect(c).toMatchObject({ runId: 'r_t2', class: 'environment' });
    expect(out.join('').toLowerCase()).toContain('/a\\u009b31m\\u202eb');
    expect(
      JSON.parse(
        readFileSync(join(p.runs, 'r_t2', 'classification.json'), 'utf8'),
      ),
    ).toEqual(c);
  });

  it.each([
    [['../r_t3']],
    [['r_NOPE']],
    [['r_missing']],
    [[]],
    [['r_t3', '--gaps']],
    [['r_t3', '--out', 'x']],
    [['r_t3', 'r_t4']],
  ])('%j is a usage or config error (exit 2), never 1', async (argv) => {
    const p = project();
    saveRun(p, 'r_t3');
    expect(await reconcile(p, ...argv)).toBe(2);
    expect(out.join('')).toBe('');
  });
});

describe('flowctl reconcile --gaps', () => {
  it('exits 2 when there is no app map to read', async () => {
    const p = project();
    expect(await reconcile(p, '--gaps')).toBe(2);
    expect(err.join('')).toContain('needs an app map');
  });
});
