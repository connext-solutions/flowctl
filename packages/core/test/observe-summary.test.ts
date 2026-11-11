import { describe, expect, it } from 'vitest';
import type { RunResult } from '../src/result.js';
import {
  freeChecks,
  observeSummary,
  type AppPage,
  type Observation,
} from '../src/observe/index.js';

const pageAt = (path: string, extra: Partial<AppPage> = {}): AppPage => ({
  path,
  title: '',
  status: 200,
  controls: [],
  links: [],
  forms: [],
  calls: [],
  consoleErrors: [],
  refused: [],
  navigationRefused: false,
  ...extra,
});

const run = (extra: Partial<RunResult> = {}): RunResult => ({
  runId: 'r_1',
  flow: 'observe',
  env: 'local',
  status: 'passed',
  steps: 0,
  healed: [],
  teardownFailed: false,
  weakLocators: [],
  evidence: { dir: '/tmp/r_1', traces: [], network: [], console: [] },
  ms: 1,
  ...extra,
});

const observation = (pages: AppPage[], r = run()): Observation => ({
  map: {
    v: 1,
    origin: 'http://127.0.0.1:5173',
    observedAt: '2026-11-12T10:00:00.000Z',
    truncated: false,
    pages,
  },
  run: r,
  file: '/tmp/r_1/appmap.json',
  budget: {
    pages: { used: 3, max: 50 },
    wallClockMs: 600_000,
    costUsd: 'unknown',
  },
});

/** The compact answer about a crawl (ADR 0033 decision 7): no verdict, the pages worth a look, at most 20. */
describe('observeSummary', () => {
  it('lists pages with no answer, a 4xx/5xx or a refusal, and carries no status', () => {
    const s = observeSummary(
      observation([
        pageAt('/'),
        pageAt('/gone', { status: 404 }),
        pageAt('/down', { status: 0 }),
        pageAt('/boom', { status: 500 }),
        pageAt('/leaky', { refused: ['scope_violation'] }),
        pageAt('/moved', { status: 302 }),
      ]),
    );
    expect(s).toEqual({
      runId: 'r_1',
      env: 'local',
      origin: 'http://127.0.0.1:5173',
      pages: 6,
      truncated: false,
      attention: ['/gone', '/down', '/boom', '/leaky'],
      budget: {
        pages: { used: 3, max: 50 },
        wallClockMs: 600_000,
        costUsd: 'unknown',
      },
      file: '/tmp/r_1/appmap.json',
    });
    expect(s).not.toHaveProperty('status');
  });

  it('keeps at most 20 attention paths, the run error and the copy path', () => {
    const pages = Array.from({ length: 25 }, (_, i) =>
      pageAt(`/p${String(i)}`, { status: 0 }),
    );
    const error = { kind: 'budget_exceeded' as const, hint: 'out of time' };
    const s = observeSummary(
      observation(pages, run({ status: 'error', error })),
      '/repo/.flows/maps/app.json',
    );
    expect(s.attention).toHaveLength(20);
    expect(s.attention[0]).toBe('/p0');
    expect(s.error).toEqual(error);
    expect(s.out).toBe('/repo/.flows/maps/app.json');
    expect(s).not.toHaveProperty('checks');
  });

  it('carries the verdict of the free checks: their status, the checks that failed and the number of findings', () => {
    const o = observation([
      pageAt('/', { links: ['/gone'] }),
      pageAt('/gone', { status: 404 }),
    ]);
    const s = observeSummary({
      ...o,
      checks: { result: freeChecks(o.map), file: '/tmp/r_1/checks.json' },
    });
    expect(s.checks).toEqual({
      status: 'failed',
      failed: ['no-4xx', 'no-broken-link'],
      findings: 2,
      file: '/tmp/r_1/checks.json',
    });
    expect(s).not.toHaveProperty('status');
  });
});
