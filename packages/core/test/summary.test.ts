import { describe, expect, it } from 'vitest';
import { exitCodeFor, summarize } from '../src/replay.js';
import type { RunResult } from '../src/result.js';

describe('summarize / exitCodeFor', () => {
  it('classifies flaky, failed and errored flows', () => {
    const r = (flow: string, status: RunResult['status']): RunResult => ({
      runId: 'x',
      flow,
      env: 'local',
      status,
      steps: 0,
      healed: [],
      teardownFailed: false,
      weakLocators: [],
      evidence: { dir: '', traces: [], network: [], console: [] },
      ms: 1,
    });
    const s = summarize([
      r('a', 'passed'),
      r('a', 'failed'),
      r('b', 'failed'),
      r('c', 'error'),
      r('d', 'passed'),
    ]);
    expect(s).toMatchObject({ passed: 1, failed: 1, flaky: 1, errors: 1 });
    expect(exitCodeFor(s)).toBe(2);
    expect(exitCodeFor(summarize([r('a', 'passed'), r('a', 'failed')]))).toBe(
      1,
    );
    expect(exitCodeFor(summarize([r('a', 'passed')]))).toBe(0);
  });
});
