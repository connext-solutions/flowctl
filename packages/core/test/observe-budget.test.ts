import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { PageBudget } from '../src/observe/index.js';

const cfg = (budgets: Record<string, number> = {}) =>
  parseConfig(
    {
      defaultEnv: 'local',
      envs: { local: { baseUrl: 'http://127.0.0.1:9' } },
      profiles: { employee: {} },
      target: { budgets },
    },
    mkdtempSync(join(tmpdir(), 'flowctl-budget-')),
  );

/** The page budget of a crawl (T2.5, ADR 0024 section 6): the repo value, never above the built-in ceiling. */
describe('PageBudget', () => {
  it('takes target.budgets.pages, the ceiling of 50 when unset, and never more than the ceiling', () => {
    expect(new PageBudget(cfg({ pages: 3 })).max).toBe(3);
    expect(new PageBudget(cfg()).max).toBe(50);
    expect(new PageBudget(cfg({ pages: 1000 })).max).toBe(50);
  });

  it('counts navigations and reports what stopped the crawl; cost stays unknown', () => {
    const b = new PageBudget(cfg({ pages: 2, wallClockMs: 5000 }));
    expect([b.take(), b.take()]).toEqual([true, true]);
    expect(b.report({ status: 'passed' })).toEqual({
      pages: { used: 2, max: 2 },
      wallClockMs: 5000,
      costUsd: 'unknown',
    });
    expect(b.take()).toBe(false);
    expect(b.report({ status: 'passed' }).stoppedBy).toBe('pages');
    expect(
      b.report({
        status: 'error',
        error: { kind: 'budget_exceeded', hint: 'x' },
      }),
    ).toMatchObject({ stoppedBy: 'wallClock', wallClockMs: 5000 });
    expect(
      new PageBudget(cfg({ wallClockMs: 9_999_999 })).report({
        status: 'passed',
      }).wallClockMs,
    ).toBe(600_000);
  });
});
