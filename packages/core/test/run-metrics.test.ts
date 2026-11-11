import { describe, expect, it } from 'vitest';
import { system1Metrics, type DecisionLogEntry } from '../src/run/index.js';

const entry = (ms: number): DecisionLogEntry => ({
  at: '2026-11-12T00:00:00.000Z',
  source: 'explore',
  step: 0,
  url: 'http://app.test/',
  ms,
  ranked: [{ op: 'DONE', p: 1 }],
  targets: {},
  outcome: 'x',
});

/** System 1 cost and time per run in `run.json` (T5.5, ADR 0024 section 6). */
describe('system1Metrics', () => {
  it('is absent when System 1 was never asked (replay without heal)', () => {
    expect(system1Metrics([])).toBeUndefined();
  });

  it('counts decisions and sums their round trips, with the median', () => {
    expect(system1Metrics([entry(30), entry(10), entry(20)])).toEqual({
      decisions: 3,
      totalMs: 60,
      medianMs: 20,
      tokens: 'unknown',
      costUsd: 'unknown',
    });
    expect(system1Metrics([entry(10), entry(40)])?.medianMs).toBe(25);
  });

  it('reports cost and tokens as unknown, never 0, when the driver reports none', () => {
    const m = system1Metrics([entry(5)]);
    expect(m?.tokens).toBe('unknown');
    expect(m?.costUsd).toBe('unknown');
  });
});
