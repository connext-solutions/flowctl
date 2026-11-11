import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findFlows } from '../src/flow/index.js';
import { replayMany } from '../src/replay.js';
import type { RunResult } from '../src/result.js';
import { BUG_MODES, startFixture, type BugMode } from '@flowctl/fixture-app';
import { PROFILES, copyFlows, fixtureConfig, seedProfiles } from './helpers.js';

type FlowName =
  | 'leave-approve'
  | 'leave-validation'
  | 'leave-submit'
  | 'leave-persist';

interface Expected {
  flow: FlowName;
  failed: Record<string, unknown>;
}

const TOAST = { text: 'Đã gửi đơn' };
const RECORD = { text: expect.stringContaining('Việc riêng') };
const POST_STATUS = { network: { method: 'POST', status: 201 } };

/**
 * Which flow must turn red for each bug, and what exactly must fail there: the first failed
 * assertion (partial match on the assertion), or the step that could not run.
 *
 * @remarks The first failing check is pinned, so the "only this assertion catches it" claim for
 * `redirectWrong` and `formNotReset` also depends on the second test below, which drops their
 * assertion and expects the flow to pass.
 *
 * Every bug is pinned to a failed assertion, never to a step abort. `save500` and `toastOnFail`
 * both break the POST, so the success toast text comes before the POST status in leave-submit:
 * `save500` shows no toast and fails the text, `toastOnFail` shows the toast and fails the status.
 */
const CAUGHT_BY: Record<BugMode, Expected> = {
  save500: { flow: 'leave-submit', failed: { assertion: TOAST } },
  notPersisted: { flow: 'leave-persist', failed: { assertion: RECORD } },
  wrongBody: {
    flow: 'leave-approve',
    failed: {
      assertion: {
        network: { method: 'POST', requestBody: { type: 'LEAVE' } },
      },
    },
  },
  toastOnFail: { flow: 'leave-submit', failed: { assertion: POST_STATUS } },
  noValidation: {
    flow: 'leave-validation',
    failed: { assertion: { text: 'Vui lòng nhập lý do' } },
  },
  consoleError: {
    flow: 'leave-approve',
    failed: { assertion: { noConsoleErrors: true } },
  },
  list500: { flow: 'leave-persist', failed: { assertion: RECORD } },
  wrongValueAfterReload: {
    flow: 'leave-persist',
    failed: { assertion: RECORD },
  },
  approve403: {
    flow: 'leave-approve',
    failed: { assertion: { network: { method: 'PATCH', status: 200 } } },
  },
  approveNoop: {
    flow: 'leave-approve',
    failed: { assertion: { text: 'Đã duyệt' } },
  },
  redirectWrong: {
    flow: 'leave-submit',
    failed: { assertion: { url: '/requests?saved=1' } },
  },
  formNotReset: {
    flow: 'leave-submit',
    failed: { assertion: { value: { equals: '' } } },
  },
  toastInList: {
    flow: 'leave-submit',
    failed: { assertion: { text: 'Đã gửi đơn', within: { role: 'status' } } },
  },
};

/**
 * Replays the fixture flows against the app with `bug` on.
 *
 * @param drop - removes that assertion kind from the flow first (or rewrites the flow), to prove no other
 *   assertion catches the bug.
 */
async function results(
  bug?: BugMode,
  drop?: { flow: FlowName; kind?: string; rewrite?: (yaml: string) => string },
): Promise<Map<string, RunResult>> {
  const f = await startFixture(bug);
  try {
    const cfg = fixtureConfig(f.url);
    await seedProfiles(cfg, f.url);
    copyFlows(cfg);
    if (drop !== undefined) {
      const file = join(cfg.flowsPath, `${drop.flow}.yaml`);
      const kept = readFileSync(file, 'utf8')
        .split('\n')
        .filter((line) => !line.startsWith(`  - ${drop.kind ?? '\0'}:`))
        .join('\n');
      writeFileSync(file, drop.rewrite?.(kept) ?? kept);
    }
    const s = await replayMany(
      cfg,
      findFlows(cfg.flowsPath, PROFILES, { tag: 'fixture' }),
      {},
    );
    return new Map(s.results.map((r) => [r.flow, r]));
  } finally {
    await f.close();
  }
}

describe('accuracy on seeded bugs', () => {
  it('passes every flow on the clean app (no false failures)', async () => {
    const statuses = [...(await results()).values()].map((r) => [
      r.flow,
      r.status,
    ]);
    expect(statuses.sort()).toEqual([
      ['leave-approve', 'passed'],
      ['leave-persist', 'passed'],
      ['leave-submit', 'passed'],
      ['leave-validation', 'passed'],
    ]);
  });

  it.each(BUG_MODES)('catches %s with the expected check', async (bug) => {
    const { flow, failed } = CAUGHT_BY[bug];
    const result = (await results(bug)).get(flow);
    expect(result?.status).toBe('failed');
    expect(result?.failed).toMatchObject(failed);
  });

  it.each([
    ['redirectWrong', 'leave-submit', 'url'],
    ['formNotReset', 'leave-submit', 'value'],
    ['notPersisted', 'leave-persist', 'text'],
    ['list500', 'leave-persist', 'text'],
    ['wrongValueAfterReload', 'leave-persist', 'text'],
  ] as const)(
    '%s is caught only by the %s %s assertion',
    async (bug, flow, kind) => {
      const result = (await results(bug, { flow, kind })).get(flow);
      expect(result?.status).toBe('passed');
    },
  );

  it('toastInList is caught only because the toast text is held within the toast region', async () => {
    const result = (
      await results('toastInList', {
        flow: 'leave-submit',
        rewrite: (y) => y.replace(', within: { role: status }', ''),
      })
    ).get('leave-submit');
    expect(result?.status).toBe('passed');
  });

  it.each([
    ['toastOnFail', 'passed'],
    ['save500', 'failed'],
  ] as const)(
    '%s with leave-submit network dropped is %s',
    async (bug, status) => {
      const drop = { flow: 'leave-submit', kind: 'network' } as const;
      const result = (await results(bug, drop)).get('leave-submit');
      expect(result?.status).toBe(status);
    },
  );
});
