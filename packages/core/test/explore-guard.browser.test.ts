import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import {
  startFakeSystem1,
  startFixture,
  type FakeMove,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
import type { LoadedConfig } from '../src/config.js';
import { Exploration, type ExploreRequest } from '../src/explore/index.js';
import { ActionGuard, DestructiveAction } from '../src/explore/guard.js';
import { initTrust, TrustStore } from '../src/trust/index.js';
import { VARS, exploreConfig, seedProfiles } from './helpers.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/**
 * The destructive-action guard on a shared env (ADR 0024 section 5, interim): System 1's click on "Duyệt …"
 * escalates `destructive_action` and no approve request is sent; the orchestrator may take it only when the
 * request sets `allowDestructive`.
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
beforeEach(async () => {
  await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
});
afterEach(async () => {
  await s1?.close();
  s1 = undefined;
});

/** A config for the fixture whose only env the trust store classes `shared`, as ERP stg would be. */
async function sharedEnv(
  moves: FakeMove[],
): Promise<{ cfg: LoadedConfig; store: TrustStore }> {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  mkdirSync(cfg.flowsPath, { recursive: true });
  const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-guard-')), 'store');
  gitRepo(cfg.root);
  initTrust({
    storeDir: dir,
    key: testOwnerKey(),
    project: 'guard',
    projectDir: cfg.root,
    flowsDir: cfg.flowsPath,
    answers: {
      envs: { local: { origin: new URL(fixture.url).origin, class: 'shared' } },
      productionOrigins: [],
      defaultEnv: 'local',
      language: 'vi',
      locale: 'vi-VN',
    },
    anchorDir: testAnchorDir(),
  });
  return { cfg, store: TrustStore.open(dir) };
}

const APPROVE: ExploreRequest = {
  goal: 'Nhân viên gửi đơn, quản lý duyệt',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng cố định' } },
  assertions: [
    {
      network: { method: 'PATCH', url: '/api/requests/*/approve', status: 200 },
    },
  ],
};

const MOVES: FakeMove[] = [
  { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
  { op: 'CLICK', target: 'Gửi' },
  { op: 'BLOCKED' },
  { op: 'WAIT' },
  { op: 'CLICK', target: 'Duyệt Việc riêng cố định' },
  { op: 'DONE' },
];

async function atApprovals(
  allowDestructive: boolean,
): Promise<{ x: Exploration; id: number }> {
  const { cfg, store } = await sharedEnv(MOVES);
  const x = await Exploration.start(
    cfg,
    { ...APPROVE, allowDestructive },
    { browser, vars: VARS, store },
  );
  expect((await x.advance()).status).toBe('escalated');
  const stop = await x.step([
    { kind: 'as', profile: 'manager' },
    { kind: 'goto', url: '/approvals' },
  ]);
  if (
    stop.status !== 'escalated' ||
    stop.escalation.reason !== 'destructive_action'
  )
    throw new Error(JSON.stringify(stop));
  const row = stop.escalation.controls.find((c) =>
    c.includes('Duyệt Việc riêng'),
  );
  return { x, id: Number(/^\[(\d+)\]/.exec(row ?? '')?.[1]) };
}

describe('destructive-action guard on a shared env', () => {
  it('does not let System 1 approve: it escalates and no approve request is sent', async () => {
    const { x } = await atApprovals(false);
    const r = await x.finish();
    expect(r.status).toBe('failed');
  });

  it('refuses the orchestrator too without allowDestructive, by control id or by locator', async () => {
    const { x, id } = await atApprovals(false);
    for (const step of [
      { kind: 'click' as const, control: id },
      {
        kind: 'click' as const,
        target: { role: 'button' as const, name: 'Duyệt Việc riêng cố định' },
      },
    ]) {
      const stop = await x.step(step);
      expect(stop).toMatchObject({
        status: 'escalated',
        escalation: { reason: 'destructive_action' },
      });
    }
    expect((await x.finish()).status).toBe('failed');
  });

  it('lets the orchestrator approve when the request allows it', async () => {
    const { x, id } = await atApprovals(true);
    const stop = await x.step({ kind: 'click', control: id });
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
  });
});

describe('the Enter check', () => {
  const FORM = (button: string) =>
    `<form onsubmit="return false"><input id="f"><button>${button}</button></form><a id="l" href="#">Xoá</a>`;

  async function enter(html: string, focus: string): Promise<boolean> {
    const page = await browser.newPage();
    try {
      await page.setContent(html);
      await page.focus(focus);
      await new ActionGuard('shared', false).checkEnter(page, 'system1');
      return false;
    } catch (e) {
      if (e instanceof DestructiveAction) return true;
      throw e;
    } finally {
      await page.close();
    }
  }

  it('refuses Enter in a field whose form submits with a destructive button', async () => {
    expect(await enter(FORM('Xoá'), '#f')).toBe(true);
  });

  it('refuses Enter on a focused destructive link or button', async () => {
    expect(await enter(FORM('Gửi'), '#l')).toBe(true);
    expect(await enter(FORM('Xoá'), 'button')).toBe(true);
  });

  it('allows Enter in an ordinary form', async () => {
    expect(await enter(FORM('Gửi'), '#f')).toBe(false);
  });
});
