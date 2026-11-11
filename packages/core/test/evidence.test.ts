import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import type { RunResult } from '../src/result.js';
import {
  Evidence,
  MAX_CONSOLE_ERRORS,
  MAX_LINE,
  MAX_SUMMARY_REQUESTS,
  type DecisionLogEntry,
} from '../src/run/index.js';

const entry = (step: number): DecisionLogEntry => ({
  at: '2026-10-08T00:00:00.000Z',
  source: 'explore',
  step,
  url: 'http://app.test/a',
  ms: 250,
  ranked: [{ op: 'CLICK', p: 0.9 }],
  targets: { CLICK: { control: '[1] button "Gửi"', p: 0.9 } },
  outcome: 'CLICK [1] button "Gửi"',
});

const result = (runId: string, dir: string): RunResult => ({
  runId,
  flow: 'f',
  env: 'local',
  status: 'passed',
  steps: 1,
  healed: [],
  teardownFailed: false,
  weakLocators: [],
  evidence: { dir, traces: [], network: [], console: [] },
  ms: 10,
});

/** A fresh flows dir and its `.runs` path (not created). */
const flowsAndRuns = (): { flows: string; runs: string } => {
  const flows = mkdtempSync(join(tmpdir(), 'flowctl-flows-'));
  return { flows, runs: join(flows, '.runs') };
};

describe('Evidence (run directory)', () => {
  it('creates <runsDir>/<runId> and appends each decision as it happens', () => {
    const { flows, runs } = flowsAndRuns();
    const ev = new Evidence(runs, 'r_1', 20, flows);
    expect(ev.dir).toBe(join(realpathSync(flows), '.runs', 'r_1'));
    expect(existsSync(ev.dir)).toBe(true);
    ev.decided(entry(0));
    ev.decided(entry(1));
    const lines = readFileSync(join(ev.dir, 'decisions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toEqual([entry(0), entry(1)]);
    expect(ev.decisions).toEqual([entry(0), entry(1)]);
  });

  it('writes run.json and keeps only the newest `retention` runs', () => {
    const { flows, runs } = flowsAndRuns();
    mkdirSync(runs);
    for (const [i, old] of ['r_a', 'r_b', 'r_c'].entries()) {
      mkdirSync(join(runs, old));
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(join(runs, old), t, t);
    }
    const ev = new Evidence(runs, 'r_new', 2, flows);
    ev.save(result('r_new', ev.dir));
    expect(
      JSON.parse(readFileSync(join(ev.dir, 'run.json'), 'utf8')).runId,
    ).toBe('r_new');
    expect(readdirSync(runs).sort()).toEqual(['.gitignore', 'r_c', 'r_new']);
  });

  it('refuses a .runs that is a symlink and leaves its target alone', () => {
    const { flows, runs } = flowsAndRuns();
    const victim = mkdtempSync(join(tmpdir(), 'flowctl-victim-'));
    writeFileSync(join(victim, 'keep.txt'), 'x');
    mkdirSync(join(victim, 'other'));
    symlinkSync(victim, runs);
    expect(() => new Evidence(runs, 'r_1', 1, flows)).toThrow(ConfigError);
    expect(readdirSync(victim).sort()).toEqual(['keep.txt', 'other']);
  });

  it('prunes only run directories and ignores everything in .runs', () => {
    const { flows, runs } = flowsAndRuns();
    mkdirSync(runs);
    writeFileSync(join(runs, 'notes.txt'), 'mine');
    mkdirSync(join(runs, 'my-dir'));
    for (const [i, old] of ['r_a', 'r_b', 'r_c'].entries()) {
      mkdirSync(join(runs, old));
      const t = new Date(Date.UTC(2026, 0, 1 + i));
      utimesSync(join(runs, old), t, t);
    }
    const ev = new Evidence(runs, 'r_new', 1, flows);
    ev.save(result('r_new', ev.dir));
    expect(readdirSync(runs).sort()).toEqual([
      '.gitignore',
      'my-dir',
      'notes.txt',
      'r_new',
    ]);
    expect(readFileSync(join(runs, '.gitignore'), 'utf8')).toBe('*\n');
  });

  it('works when the flows dir itself is a symlink', () => {
    const real = mkdtempSync(join(tmpdir(), 'flowctl-real-'));
    const flows = join(mkdtempSync(join(tmpdir(), 'flowctl-link-')), 'flows');
    symlinkSync(real, flows);
    const ev = new Evidence(join(flows, '.runs'), 'r_1', 1, flows);
    ev.save(result('r_1', ev.dir));
    expect(existsSync(join(real, '.runs', 'r_1', 'run.json'))).toBe(true);
  });
});

describe('Evidence bounds (#57)', () => {
  it('keeps at most MAX_CONSOLE_ERRORS clipped lines and counts the rest', () => {
    const { flows, runs } = flowsAndRuns();
    const ev = new Evidence(runs, 'r_1', 1, flows);
    for (let i = 0; i < MAX_CONSOLE_ERRORS + 30; i++)
      ev.noteConsoleError('p', `boom ${i} ${'y'.repeat(MAX_LINE * 2)}`);
    expect(ev.consoleErrors).toHaveLength(MAX_CONSOLE_ERRORS);
    expect(ev.droppedConsoleErrors).toBe(30);
    ev.flushLogs();
    const written: unknown = JSON.parse(
      readFileSync(join(ev.dir, 'console.json'), 'utf8'),
    );
    expect(Array.isArray(written) ? written.at(-1) : undefined).toBe(
      '… and 30 more not kept (see trace-<profile>.zip)',
    );
    expect(ev.consoleErrors[0]?.startsWith('[p] boom 0 ')).toBe(true);
    expect(
      ev.consoleErrors.every((l) => l.length <= MAX_LINE + '[p] '.length + 1),
    ).toBe(true);
  });

  it('lists at most MAX_SUMMARY_REQUESTS failed requests in the run summary', async () => {
    const { flows, runs } = flowsAndRuns();
    const ev = new Evidence(runs, 'r_1', 1, flows);
    for (let i = 0; i < MAX_SUMMARY_REQUESTS + 5; i++)
      ev.network.push({
        profile: 'p',
        method: 'GET',
        url: `http://h/api/poll/${i}`,
        status: 500,
        requestBody: undefined,
      });
    const summary = await ev.collect([]);
    expect(summary.network).toHaveLength(MAX_SUMMARY_REQUESTS + 1);
    expect(summary.network.at(-1)).toBe('… and 5 more in network.json');
  });
});
