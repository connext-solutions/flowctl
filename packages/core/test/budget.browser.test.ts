import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Exploration } from '../src/explore/index.js';
import { replayFlow } from '../src/replay.js';
import { consentHooks, testStore } from './trust-fixture.js';
import {
  startFakeSystem1,
  startFixture,
  type Fixture,
} from '@flowctl/fixture-app';
import {
  VARS,
  exploreConfig,
  fixtureConfig,
  seedProfiles,
  writeFlow,
} from './helpers.js';

let fixture: Fixture;
let browser: Browser;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

/** The wall-clock budget is an independent timer: it stops a step that is still running (ADR 0024 section 6). */
describe('wall-clock budget', () => {
  it('stops a replay in the middle of a long step and ends it budget_exceeded, with evidence', async () => {
    const cfg = fixtureConfig(fixture.url, {
      target: { budgets: { wallClockMs: 1500 } },
    });
    await seedProfiles(cfg, fixture.url);
    const flow = writeFlow(cfg, {
      name: 'slow',
      goal: 'g',
      profile: 'employee',
      start: '/requests',
      steps: [{ wait: 20_000 }, { click: { role: 'button', name: 'Gửi' } }],
      assertions: [{ text: 'Vui lòng nhập lý do' }],
    });
    const r = await replayFlow(cfg, flow, { browser });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('budget_exceeded');
    expect(r.error?.hint).toContain('target.budgets.wallClockMs');
    expect(r.ms).toBeLessThan(10_000);
    expect(r.steps).toBe(0);
    expect(r.evidence.traces).toHaveLength(1);
  });

  it('opens no page and acts on nothing when the budget runs out during the setup hook', async () => {
    const cfg = fixtureConfig(fixture.url, {
      target: { budgets: { wallClockMs: 500 } },
    });
    await seedProfiles(cfg, fixture.url);
    const flow = writeFlow(cfg, {
      name: 'slow-setup',
      goal: 'g',
      profile: 'employee',
      start: '/requests',
      setup: 'sleep 2',
      steps: [{ click: { role: 'button', name: 'Gửi' } }],
      assertions: [{ text: 'Vui lòng nhập lý do' }],
    });
    const store = consentHooks(cfg, testStore(cfg), [flow]);
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.error?.kind).toBe('budget_exceeded');
    expect(r.steps).toBe(0);
    expect(r.evidence.traces).toEqual([]);
  });

  it('leaves a run that ends in time alone', async () => {
    const cfg = fixtureConfig(fixture.url, {
      target: { budgets: { wallClockMs: 60_000 } },
    });
    await seedProfiles(cfg, fixture.url);
    const flow = writeFlow(cfg, {
      name: 'quick',
      goal: 'g',
      profile: 'employee',
      start: '/requests',
      steps: [{ click: { role: 'button', name: 'Gửi' } }],
      assertions: [{ text: 'Vui lòng nhập lý do' }],
    });
    const r = await replayFlow(cfg, flow, { browser });
    expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
  });

  it('ends an escalated exploration budget_exceeded, not action_failed, when the agent steps after the budget ran out', async () => {
    const s1 = await startFakeSystem1([{ op: 'BLOCKED' }]);
    try {
      const cfg = exploreConfig(fixture.url, s1.url, {
        target: { budgets: { wallClockMs: 1500 } },
      });
      await seedProfiles(cfg, fixture.url);
      const x = await Exploration.start(
        cfg,
        {
          goal: 'Gửi đơn',
          start: '/requests',
          profile: 'employee',
          assertions: [{ text: 'Đã gửi' }],
        },
        { browser, vars: VARS },
      );
      expect((await x.advance()).status).toBe('escalated');
      await new Promise((r) => setTimeout(r, 2000));
      const stop = await x.step([{ kind: 'click', control: 1 }]);
      expect(stop.status).toBe('error');
      expect(stop.status === 'error' ? stop.error?.kind : stop.status).toBe(
        'budget_exceeded',
      );
    } finally {
      await s1.close();
    }
  });
});
