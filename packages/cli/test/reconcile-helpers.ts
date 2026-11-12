import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';
import { loadConfig, type TrustStore } from '@flowctl/core';
import { gitRepo, testStore } from '@flowctl/core-testing';
import { runCli } from '../src/main.js';

/** Shared set-up of the `flowctl reconcile` unit tests: a project with hand-written run directories. */
export interface Project {
  root: string;
  flows: string;
  file: string;
  runs: string;
  store: TrustStore;
}

/** What the command wrote to stdout and stderr in the current test, after {@link captureOutput}. */
export const io = { out: [] as string[], err: [] as string[] };

/** Captures stdout and stderr into {@link io} for every test of the calling file. */
export function captureOutput(): void {
  beforeEach(() => {
    io.out = [];
    io.err = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
      io.out.push(String(s));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
      io.err.push(String(s));
      return true;
    });
  });
  afterEach(() => vi.restoreAllMocks());
}

export function project(): Project {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-reconcile-'));
  mkdirSync(join(root, '.flows', '.runs'), { recursive: true });
  const file = join(root, 'flowctl.config.yaml');
  writeFileSync(
    file,
    'defaultEnv: local\nenvs:\n  local: { baseUrl: "http://127.0.0.1:9", loginUrl: /login }\nprofiles:\n  employee: {}\n',
  );
  gitRepo(root);
  return {
    root,
    flows: join(root, '.flows'),
    file,
    runs: join(root, '.flows', '.runs'),
    store: testStore(loadConfig(file)),
  };
}

export const runJson = (runId: string, over: object = {}): string =>
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
  });

export function saveRun(p: Project, runId: string, over: object = {}): void {
  mkdirSync(join(p.runs, runId));
  writeFileSync(join(p.runs, runId, 'run.json'), runJson(runId, over));
}

/** An empty but valid `AppMap`. */
export const MAP = JSON.stringify({
  v: 1,
  origin: 'http://127.0.0.1:9',
  observedAt: '2026-11-12T10:00:00.000Z',
  truncated: false,
  pages: [],
});

export const reconcile = (p: Project, ...argv: string[]): Promise<number> =>
  runCli(['reconcile', ...argv, '--config', p.file], {
    openStore: () => p.store,
  });

/** The control characters of `text` other than newline. */
export const controls = (text: string): string[] =>
  [...text].filter((c) => {
    const n = c.codePointAt(0) ?? 0;
    return c !== '\n' && (n < 0x20 || (n >= 0x7f && n <= 0x9f));
  });

/** A fresh directory outside the project. */
export const elsewhere = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'flowctl-reconcile-out-')));
