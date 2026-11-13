import type { ReplaySummary, RunResult } from '@flowctl/core';
import { describe, expect, it } from 'vitest';
import { formatSummary } from '../src/index.js';
import { formatCleanup, MAX_SHOWN, terminalSafe } from '../src/summary.js';

function result(over: Partial<RunResult>): RunResult {
  return {
    runId: 'r1',
    flow: 'sample',
    env: 'local',
    status: 'passed',
    steps: 1,
    healed: [],
    teardownFailed: false,
    weakLocators: [],
    evidence: {
      dir: '/runs/r1',
      traces: [],
      network: [],
      console: [],
    },
    ms: 12,
    provenance: 'hand-written',
    provenanceNotes: [],
    ...over,
  };
}

function summary(
  results: RunResult[],
  over: Partial<ReplaySummary> = {},
): ReplaySummary {
  return {
    results,
    flows: [],
    passed: 0,
    failed: 0,
    flaky: 0,
    errors: 0,
    ...over,
  };
}

describe('formatSummary', () => {
  it('prints a passed run with its duration and the totals line', () => {
    const text = formatSummary(summary([result({})], { passed: 1 }));
    expect(text).toBe(
      '✔ sample [local] 12ms\n1 passed, 0 failed, 0 flaky, 0 errors\n',
    );
  });

  it.each([
    ['unverified', 'claims it was derived'],
    ['unclassified', 'does not list it as hand-written'],
  ] as const)(
    'labels a %s flow as unverified provenance',
    (provenance, why) => {
      const text = formatSummary(
        summary([result({ provenance })], { passed: 1 }),
      );
      expect(text).toContain(
        '✔ sample [local] 12ms\n  ⚠ unverified provenance:',
      );
      expect(text).toContain(why);
    },
  );

  it('does not label a hand-written flow, nor a flow file that never ran', () => {
    expect(formatSummary(summary([result({})], { passed: 1 }))).not.toContain(
      'provenance',
    );
    const unloaded = result({
      status: 'error',
      provenance: 'unclassified',
      evidence: { dir: '', traces: [], network: [], console: [] },
    });
    expect(formatSummary(summary([unloaded], { errors: 1 }))).not.toContain(
      'provenance',
    );
  });

  it('prints a failed step with its evidence directory', () => {
    const text = formatSummary(
      summary(
        [
          result({
            status: 'failed',
            failed: { step: 2, kind: 'not_found', message: 'no button' },
          }),
        ],
        { failed: 1 },
      ),
    );
    expect(text).toContain('✘ sample [local] step 2 not_found: no button');
    expect(text).toContain('  evidence: /runs/r1');
    expect(text).toContain('0 passed, 1 failed');
  });

  it('prints a failed assertion with what was observed', () => {
    const text = formatSummary(
      summary([
        result({
          status: 'failed',
          failed: { assertion: { text: 'Saved' }, got: 'nothing' },
        }),
      ]),
    );
    expect(text).toContain('assertion {"text":"Saved"} got: nothing');
  });

  it('prints a bare "failed" when no failure detail was recorded', () => {
    const text = formatSummary(summary([result({ status: 'failed' })]));
    expect(text).toContain('✘ sample [local] failed\n');
  });

  it('prints an error with its kind and hint, and falls back to internal', () => {
    const withKind = formatSummary(
      summary([
        result({
          status: 'error',
          error: { kind: 'profile_expired', hint: 'run flowctl login admin' },
        }),
      ]),
    );
    expect(withKind).toContain(
      '! sample [local] error profile_expired: run flowctl login admin',
    );
    const without = formatSummary(summary([result({ status: 'error' })]));
    expect(without).toContain('error internal: ');
  });

  it('adds teardown and weak-locator warnings under the run', () => {
    const text = formatSummary(
      summary([
        result({ teardownFailed: true, weakLocators: ['step 1', 'step 3'] }),
      ]),
    );
    expect(text).toContain('  ⚠ teardown failed (see /runs/r1)');
    expect(text).toContain('  ⚠ weak locators: step 1, step 3');
  });

  it('lists only flaky flows with their statuses', () => {
    const text = formatSummary(
      summary([], {
        flaky: 1,
        flows: [
          {
            flow: 'steady',
            runs: 2,
            statuses: ['passed', 'passed'],
            flaky: false,
          },
          {
            flow: 'wobbly',
            runs: 2,
            statuses: ['passed', 'failed'],
            flaky: true,
          },
        ],
      }),
    );
    expect(text).toContain('~ wobbly flaky: passed, failed');
    expect(text).not.toContain('steady');
    expect(text).toContain('0 passed, 0 failed, 1 flaky, 0 errors');
  });
});

describe('formatSummary with page-controlled text (issue #54)', () => {
  const FORGED =
    '\r\u001b[2K✔ create-holiday [staging] 812ms\n1 passed, 0 failed, 0 flaky, 0 errors\u001b[8m';

  it('escapes escape sequences and newlines in got, so a page cannot forge a pass line', () => {
    const text = formatSummary(
      summary(
        [
          result({
            status: 'failed',
            failed: { assertion: { text: 'Đã lưu' }, got: FORGED },
          }),
        ],
        { failed: 1 },
      ),
    );
    const controls = [...text].filter((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return c !== '\n' && (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f));
    });
    expect(controls).toEqual([]);
    expect(text.split('\n').filter((l) => l.startsWith('✔'))).toEqual([]);
    expect(text).toContain('\\u{001B}[8m');
    expect(text.trimEnd().split('\n').at(-1)).toBe(
      '0 passed, 1 failed, 0 flaky, 0 errors',
    );
  });

  it('escapes step messages, error hints, weak locators and bidi overrides, and truncates long text', () => {
    const text = formatSummary(
      summary(
        [
          result({
            status: 'failed',
            failed: { step: 2, kind: 'not_found', message: 'a\u202eb' },
          }),
          result({
            status: 'error',
            error: { kind: 'app_unreachable', hint: `x${'y'.repeat(500)}` },
            weakLocators: ['Lưu\u001b[8m'],
          }),
        ],
        { failed: 1, errors: 1 },
      ),
    );
    expect(text).toContain('a\\u{202E}b');
    expect(text).toContain('Lưu\\u{001B}[8m');
    expect(text).toContain(`x${'y'.repeat(MAX_SHOWN - 1)}…`);
    expect(text).not.toContain('y'.repeat(MAX_SHOWN));
  });

  it('keeps ordinary Vietnamese text as it is', () => {
    expect(terminalSafe('Vui lòng nhập lý do')).toBe('Vui lòng nhập lý do');
  });
});

describe('formatCleanup', () => {
  it('warns when the ledger had a torn last line', () => {
    const text = formatCleanup('r_torn01', {
      confirmed: 1,
      leftover: [],
      tornTail: true,
    });
    expect(text).toContain('1 record(s) confirmed deleted, 0 left');
    expect(text).toContain('the last line of the ledger was torn');
    expect(
      formatCleanup('r_ok01', { confirmed: 1, leftover: [] }),
    ).not.toContain('torn');
  });
});
