import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Exploration, type ExploreRequest } from '../src/explore/index.js';
import {
  startFakeSystem1,
  startFixture,
  type FakeMove,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
import { VARS, exploreConfig, seedProfiles } from './helpers.js';

/**
 * An exploration never passes before it has acted (issue #47, task T1.11): `/requests` shows "Đơn từ" on arrival, so
 * an assertion on it held before System 1 did anything, and the run used to end `passed` with no step. Such a run
 * proves nothing and cannot be saved (a flow needs a step).
 */
let fixture: Fixture;
let browser: Browser;
let s1: FakeSystem1 | undefined;
beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
afterEach(async () => {
  await s1?.close();
  s1 = undefined;
});

const ALREADY_THERE: ExploreRequest = {
  goal: 'Mở trang đơn từ',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng {{uid}}' } },
  assertions: [{ text: 'Đơn từ' }],
};

async function explore(moves: FakeMove[]) {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  const x = await Exploration.start(cfg, ALREADY_THERE, {
    browser,
    vars: VARS,
  });
  return { x, stop: await x.advance() };
}

describe('no pass before the first action', () => {
  it('does not pass on arrival; DONE before any action is rejected', async () => {
    const idle = { op: 'DONE', second: { op: 'WAIT' } };
    const { stop } = await explore([idle, idle, idle]);
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'done_rejected' },
    });
  });

  it('ends finish() before any action as flow_invalid, never passed', async () => {
    const { x, stop } = await explore([{ op: 'BLOCKED' }]);
    expect(stop.status).toBe('escalated');
    expect(await x.finish()).toMatchObject({
      status: 'error',
      error: { kind: 'flow_invalid' },
    });
  });

  it('counts an orchestrator step as acting, so finish() then gives the verdict', async () => {
    const { x } = await explore([{ op: 'BLOCKED' }]);
    await x.step({ kind: 'goto', url: '/requests' }).catch(() => undefined);
    expect((await x.finish()).status).toBe('passed');
  });

  it('passes once System 1 has acted and the assertions hold', async () => {
    const { stop } = await explore([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'DONE' },
    ]);
    expect(stop.status).toBe('passed');
    expect('steps' in stop ? stop.steps : undefined).toBe(1);
  });
});
