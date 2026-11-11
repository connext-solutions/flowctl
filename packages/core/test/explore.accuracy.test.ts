import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Exploration, type ExploreRequest } from '../src/explore/index.js';
import {
  startFakeSystem1,
  startFixture,
  type BugMode,
  type FakeMove,
} from '@flowctl/fixture-app';
import { VARS, exploreConfig, seedProfiles } from './helpers.js';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** A System 1 that fills, submits, then insists the goal is done: the worst case for false passes. */
const MOVES: FakeMove[] = [
  { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
  { op: 'CLICK', target: 'Gửi' },
  { op: 'DONE', second: { op: 'WAIT' } },
];

const REQUEST: ExploreRequest = {
  goal: 'Gửi đơn nghỉ và thấy đơn trong danh sách',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng {{uid}}' } },
  assertions: [
    {
      network: {
        method: 'POST',
        url: '/api/requests',
        status: 201,
        requestBody: { type: 'LEAVE' },
      },
    },
    { text: 'Việc riêng {{uid}}' },
    { noConsoleErrors: true },
  ],
};

async function exploreWith(bug?: BugMode) {
  const fixture = await startFixture(bug);
  const s1 = await startFakeSystem1(MOVES);
  try {
    const cfg = exploreConfig(fixture.url, s1.url, { assertTimeout: 1000 });
    await seedProfiles(cfg, fixture.url);
    const x = await Exploration.start(cfg, REQUEST, { browser, vars: VARS });
    const stop = await x.advance();
    if (stop.status === 'escalated') await x.finish();
    return stop;
  } finally {
    await s1.close();
    await fixture.close();
  }
}

describe('exploration accuracy (a DONE-happy System 1 never makes a bug pass)', () => {
  it('passes on the clean app', async () => {
    expect((await exploreWith()).status).toBe('passed');
  });

  it.each<BugMode>([
    'save500',
    'notPersisted',
    'wrongBody',
    'toastOnFail',
    'consoleError',
    'list500',
  ])('does not pass with seeded bug %s', async (bug) => {
    const stop = await exploreWith(bug);
    expect(stop.status, JSON.stringify(stop)).not.toBe('passed');
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'done_rejected' },
    });
  });
});
