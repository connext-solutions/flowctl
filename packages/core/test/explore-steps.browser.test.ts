import { chromium, type Browser } from 'playwright';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import type { LoadedConfig } from '../src/config.js';
import { Exploration, type ExploreRequest } from '../src/explore/index.js';
import {
  startFakeSystem1,
  startFixture,
  type FakeMove,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
import { VARS, exploreConfig, seedProfiles } from './helpers.js';

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
beforeEach(async () => {
  await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
});
afterEach(async () => {
  await s1?.close();
  s1 = undefined;
});

async function setup(moves: FakeMove[]): Promise<LoadedConfig> {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  return cfg;
}

const SUBMIT: ExploreRequest = {
  goal: 'Gửi đơn nghỉ',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng cố định' } },
  assertions: [
    { network: { method: 'POST', url: '/api/requests', status: 201 } },
    { text: 'Đã gửi đơn' },
  ],
};

const start = (cfg: LoadedConfig, req: ExploreRequest) =>
  Exploration.start(cfg, req, { browser, vars: VARS });

describe('Exploration.step', () => {
  it('runs an orchestrator click on a control id from the escalation, then continues', async () => {
    const cfg = await setup([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'BLOCKED' },
      { op: 'DONE' },
    ]);
    const x = await start(cfg, SUBMIT);
    const stop = await x.advance();
    if (stop.status !== 'escalated') throw new Error(JSON.stringify(stop));
    const line = stop.escalation.controls.find((c) =>
      c.endsWith('button "Gửi"'),
    );
    const id = Number(/^\[(\d+)\]/.exec(line ?? '')?.[1]);
    const after = await x.step({ kind: 'click', control: id });
    expect(after.status, JSON.stringify(after)).toBe('passed');
    expect(x.recording()?.steps[1]).toEqual({
      kind: 'click',
      target: { role: 'button', name: 'Gửi' },
      by: 'system2',
    });
  });

  it('switches role with as + goto, then System 1 finishes as the manager', async () => {
    const cfg = await setup([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'CLICK', target: 'Gửi' },
      { op: 'BLOCKED' },
      { op: 'CLICK', target: 'Duyệt Việc riêng cố định', waitForTarget: true },
      { op: 'DONE' },
    ]);
    const x = await start(cfg, {
      ...SUBMIT,
      goal: 'Nhân viên gửi đơn, quản lý duyệt',
      assertions: [
        {
          network: {
            method: 'PATCH',
            url: '/api/requests/*/approve',
            status: 200,
          },
        },
        { text: 'Đã duyệt đơn' },
      ],
    });
    expect((await x.advance()).status).toBe('escalated');
    const stop = await x.step([
      { kind: 'as', profile: 'manager' },
      { kind: 'goto', url: '/approvals' },
    ]);
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
    expect(x.recording()?.steps).toEqual([
      {
        kind: 'fill',
        target: { role: 'textbox', name: 'Lý do' },
        input: 'reason',
      },
      { kind: 'click', target: { role: 'button', name: 'Gửi' } },
      { kind: 'as', profile: 'manager', goto: '/approvals', by: 'system2' },
      {
        kind: 'click',
        target: { role: 'button', name: 'Duyệt Việc riêng cố định' },
      },
    ]);
  });

  it('expands templates in an orchestrator step but records the template', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }, { op: 'DONE' }]);
    const x = await start(cfg, {
      ...SUBMIT,
      assertions: [{ url: '*/requests?ref={{uid}}' }],
    });
    expect((await x.advance()).status).toBe('escalated');
    const stop = await x.step({ kind: 'goto', url: '/requests?ref={{uid}}' });
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
    expect(x.recording()?.steps).toEqual([
      { kind: 'goto', url: '/requests?ref={{uid}}', by: 'system2' },
    ]);
  });

  it('escalates action_failed with a hint when a step has a malformed template', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }, { op: 'DONE' }]);
    const x = await start(cfg, SUBMIT);
    await x.advance();
    const stop = await x.step({ kind: 'goto', url: '/requests?x={{today+}}' });
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'action_failed' },
    });
    expect(JSON.stringify(stop)).toContain('lbrace');
  });

  it('escalates action_failed when an orchestrator step fails', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }]);
    const x = await start(cfg, SUBMIT);
    await x.advance();
    const stop = await x.step({
      kind: 'click',
      target: { role: 'button', name: 'Không tồn tại' },
    });
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'action_failed' },
    });
  });

  it('escalates action_failed for a step that fails validation, before any step runs (#45)', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }]);
    const x = await start(cfg, SUBMIT);
    await x.advance();
    const stop = await x.step(
      JSON.parse(
        '[{"kind":"reload"},{"kind":"goto","url":"file:///etc/passwd"}]',
      ),
    );
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'action_failed' },
    });
    expect(JSON.stringify(stop)).toContain('Invalid step 2');
  });

  it('adds hints to the goal System 1 sees', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }]);
    const x = await start(cfg, SUBMIT);
    await x.advance();
    x.hint('Nút gửi nằm cuối form');
    await x.advance();
    expect(JSON.stringify(s1?.requests.at(-1))).toContain(
      'Hint: Nút gửi nằm cuối form',
    );
  });
});

describe('System 1 keys and scrolling', () => {
  it('submits an Enter-only form with PRESS_ENTER', async () => {
    const cfg = await setup([
      { op: 'TYPE_TEXT', target: 'Việc cần làm', input: 'todo' },
      { op: 'PRESS_ENTER' },
      { op: 'DONE' },
    ]);
    const x = await start(cfg, {
      goal: 'Thêm việc cần làm',
      start: '/lab',
      profile: 'employee',
      inputs: { todo: { value: 'Mua sữa' } },
      assertions: [{ text: 'Mua sữa' }],
    });
    expect((await x.advance()).status).toBe('passed');
    expect(x.recording()?.steps.at(-1)).toEqual({
      kind: 'press',
      key: 'Enter',
    });
  });

  it('scrolls to an off-screen control and records the scroll', async () => {
    const cfg = await setup([
      { op: 'SCROLL_DOWN' },
      { op: 'WAIT' },
      { op: 'CLICK', target: 'Cuối trang' },
      { op: 'DONE' },
    ]);
    const x = await start(cfg, {
      goal: 'Bấm nút cuối trang',
      start: '/lab',
      profile: 'employee',
      assertions: [{ text: 'Đã tới cuối' }],
    });
    expect((await x.advance()).status).toBe('passed');
    expect(x.recording()?.steps).toEqual([
      { kind: 'scroll', dy: 560 },
      { kind: 'click', target: { role: 'button', name: 'Cuối trang' } },
    ]);
  });
});
