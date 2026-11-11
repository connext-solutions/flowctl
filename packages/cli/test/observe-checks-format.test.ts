import type { CheckFinding, CheckId, FreeChecks } from '@flowctl/core';
import { describe, expect, it } from 'vitest';
import { formatChecks } from '../src/observe-cmd.js';

const finding = (id: CheckId, i: number): CheckFinding => ({
  check: id,
  page: `/p${i}`,
  message: `e${i}`,
  sourceRef: { kind: 'invariant', ref: id },
  observation: {
    kind: 'observation',
    file: 'appmap.json',
    pointer: `/pages/${i}/consoleErrors/0`,
  },
});

const checksWith = (kept: number, omitted: number): FreeChecks => ({
  v: 1,
  origin: 'http://127.0.0.1:5173',
  truncated: false,
  status: 'failed',
  checks: [
    {
      id: 'no-console-error',
      status: 'failed',
      findings: Array.from({ length: kept }, (_, i) =>
        finding('no-console-error', i),
      ),
      omitted,
    },
    ...(
      ['no-4xx', 'no-5xx', 'no-broken-link', 'no-unreachable-page'] as const
    ).map((id) => ({
      id,
      status: 'passed' as const,
      findings: [],
      omitted: 0,
    })),
  ],
});

/** The human lines of `flowctl observe` about the free checks. */
describe('formatChecks', () => {
  it('counts in "more in checks.json" only the findings the file holds, and the omitted ones apart', () => {
    const lines = formatChecks(checksWith(200, 5), '/runs/r_1/checks.json');
    expect(lines[0]).toBe('Checks: failed (no-console-error: 205)');
    expect(
      lines.filter((l) => l.startsWith('  no-console-error')),
    ).toHaveLength(20);
    expect(lines).toContain('  … 180 more in checks.json');
    expect(lines).toContain(
      "  … 5 more not kept in checks.json (past a check's finding cap, counted in omitted)",
    );
    expect(lines.at(-1)).toBe('Checks file: /runs/r_1/checks.json');
  });

  it('prints no "more" line when every kept finding is printed and none was omitted', () => {
    const lines = formatChecks(checksWith(3, 0), 'checks.json');
    expect(lines.some((l) => l.includes('more'))).toBe(false);
  });

  it('says omitted findings are not kept even when the kept ones all fit', () => {
    const lines = formatChecks(checksWith(3, 2), 'checks.json');
    expect(lines.some((l) => l.endsWith('more in checks.json'))).toBe(false);
    expect(lines).toContain(
      "  … 2 more not kept in checks.json (past a check's finding cap, counted in omitted)",
    );
  });
});
