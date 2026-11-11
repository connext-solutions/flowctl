import type { ExploreStop } from '@flowctl/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDLE_MS, MAX_RUNS, Runs, WAIT_MS } from '../src/runs.js';

/**
 * The run registry of the MCP server (ADR 0027): bounded waits, one operation per run, a slot limit that only
 * open runs count against, failures kept and reported, idle runs swept.
 */
const escalated = (runId: string): ExploreStop => ({
  runId,
  status: 'escalated',
  steps: 1,
  escalation: { reason: 'BLOCKED', detail: '', controls: [] },
});

const failed = (runId: string): ExploreStop => ({
  runId,
  flow: 'exploration',
  env: 'local',
  status: 'failed',
  steps: 1,
  healed: [],
  teardownFailed: false,
  weakLocators: [],
  evidence: { dir: '', traces: [], network: [], console: [] },
  ms: 1,
});

function stub(runId: string) {
  return { runId, finish: vi.fn(() => Promise.resolve(failed(runId))) };
}

const later = <T>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} => {
  let resolve: (v: T) => void = () => {};
  let reject: (e: unknown) => void = () => {};
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('Runs', () => {
  it('answers running after WAIT_MS, refuses a second operation while busy, and flow_wait gets the result', async () => {
    const runs = new Runs<ReturnType<typeof stub>>();
    runs.add(stub('r1'));
    const op = later<ExploreStop>();
    const first = runs.drive('r1', () => op.promise);
    await vi.advanceTimersByTimeAsync(WAIT_MS);
    expect(await first).toEqual({ runId: 'r1', status: 'running' });
    const second = vi.fn(() => Promise.resolve(escalated('r1')));
    expect(await runs.drive('r1', second)).toEqual({
      runId: 'r1',
      status: 'running',
    });
    expect(second).not.toHaveBeenCalled();
    const waiting = runs.wait('r1');
    op.resolve(escalated('r1'));
    expect(await waiting).toMatchObject({ status: 'escalated' });
  });

  it('counts only open runs against MAX_RUNS, including ones still starting', async () => {
    const runs = new Runs<ReturnType<typeof stub>>();
    const releases = Array.from({ length: MAX_RUNS }, () => runs.reserve());
    expect(() => runs.reserve()).toThrow(/explorations are open/);
    for (const release of releases) release();
    for (let i = 0; i < MAX_RUNS; i++) {
      runs.add(stub(`r${i}`));
      await runs.drive(`r${i}`, () => Promise.resolve(failed(`r${i}`)));
    }
    expect(() => runs.reserve()).not.toThrow();
  });

  it('keeps a rejected operation, reports it, ends the run, and rethrows it on the next call', async () => {
    const onError = vi.fn();
    const runs = new Runs<ReturnType<typeof stub>>(onError);
    const x = stub('r1');
    runs.add(x);
    await expect(
      runs.drive('r1', () => Promise.reject(new Error('browser crashed'))),
    ).rejects.toThrow('browser crashed');
    expect(onError).toHaveBeenCalled();
    expect(x.finish).toHaveBeenCalled();
    await expect(runs.wait('r1')).rejects.toThrow('browser crashed');
  });

  it('sweeps idle runs, survives a failing finish, and leaves busy runs alone', async () => {
    const onError = vi.fn();
    const runs = new Runs<ReturnType<typeof stub>>(onError);
    const idle = stub('idle');
    idle.finish.mockRejectedValueOnce(new Error('teardown failed'));
    const other = stub('other');
    const busy = stub('busy');
    for (const x of [idle, other, busy]) runs.add(x);
    void runs.drive('busy', () => later<ExploreStop>().promise);
    await runs.sweep(Date.now() + IDLE_MS + 1);
    expect(idle.finish).toHaveBeenCalled();
    expect(other.finish).toHaveBeenCalled();
    expect(busy.finish).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(new Error('teardown failed'));
    await expect(runs.wait('idle')).rejects.toThrow('Unknown run');
  });

  it('refuses a save while the run is busy', async () => {
    const runs = new Runs<ReturnType<typeof stub>>();
    runs.add(stub('r1'));
    void runs.drive('r1', () => later<ExploreStop>().promise);
    await expect(
      runs.exclusive('r1', () => Promise.resolve(1)),
    ).rejects.toThrow('flow_wait');
  });
});
