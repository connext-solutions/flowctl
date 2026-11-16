import type { Leftover, RunResult } from '@flowctl/core';
import { describe, expect, it } from 'vitest';
import { MAX_LEFTOVER, replayView } from '../src/shape.js';

/** The JSON `flow_replay` returns stays small: a run's leftover records are listed up to a cap and counted. */
const run = (leftover: Leftover[]): RunResult => ({
  runId: 'r_shape01',
  flow: 'items-crud',
  env: 'stg',
  status: 'passed',
  steps: 3,
  healed: [],
  teardownFailed: false,
  cleanup: { confirmed: 0, leftover },
  weakLocators: [],
  provenance: 'unclassified',
  provenanceNotes: [],
  evidence: { dir: '', traces: [], network: [], console: [] },
  ms: 1,
});

const left = (n: number): Leftover[] =>
  Array.from({ length: n }, (_, i) => ({
    entry: 'items-crud-create',
    id: String(i),
    name: null,
    detail: 'cleanup_failed',
  }));

const cleanupOf = (r: RunResult): unknown => {
  const view = replayView({
    results: [r],
    flows: [],
    passed: 1,
    failed: 0,
    flaky: 0,
    errors: 0,
  });
  const [only] = Array.isArray(view['notPassed']) ? view['notPassed'] : [];
  return typeof only === 'object' && only !== null && 'cleanup' in only
    ? only.cleanup
    : undefined;
};

describe('replayView', () => {
  it(`lists at most ${MAX_LEFTOVER} leftover records of a run and counts them all`, () => {
    expect(cleanupOf(run(left(25)))).toEqual({
      confirmed: 0,
      leftover: left(MAX_LEFTOVER),
      leftoverCount: 25,
    });
    expect(cleanupOf(run(left(2)))).toEqual({
      confirmed: 0,
      leftover: left(2),
    });
  });
});
