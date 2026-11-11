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
import { initTrust, TrustStore } from '../src/trust/index.js';
import { VARS, exploreConfig, seedProfiles } from './helpers.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/**
 * The request layer of the destructive-action guard (ADR 0024 section 5, T1.3 chunk 1) on an env the trust store
 * classes `shared`: `/map` has an icon-only button "🗑" whose `fetch('/map/purge')` wipes every leave request. Its
 * label holds no destructive word, so only the request layer can stop it.
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
  const created = await fetch(`${fixture.url}/api/requests`, {
    method: 'POST',
    headers: { cookie: 'role=employee', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'QA giữ lại', amount: 1 }),
  });
  expect(created.status).toBe(201);
});
afterEach(async () => {
  await s1?.close();
  s1 = undefined;
});

const requestsLeft = async (): Promise<number> => {
  const r = await fetch(`${fixture.url}/api/requests`, {
    headers: { cookie: 'role=employee' },
  });
  const body: unknown = await r.json();
  return typeof body === 'object' &&
    body !== null &&
    'items' in body &&
    Array.isArray(body.items)
    ? body.items.length
    : -1;
};

async function explore(
  moves: FakeMove[],
  envClass: 'shared' | 'local',
  allowDestructive = false,
): Promise<Exploration> {
  s1 = await startFakeSystem1(moves);
  const cfg: LoadedConfig = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  mkdirSync(cfg.flowsPath, { recursive: true });
  const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-writes-')), 'store');
  gitRepo(cfg.root);
  initTrust({
    storeDir: dir,
    key: testOwnerKey(),
    project: 'writes',
    projectDir: cfg.root,
    flowsDir: cfg.flowsPath,
    answers: {
      envs: { local: { origin: new URL(fixture.url).origin, class: envClass } },
      productionOrigins: [],
      defaultEnv: 'local',
      language: 'vi',
      locale: 'vi-VN',
    },
    anchorDir: testAnchorDir(),
  });
  const req: ExploreRequest = {
    goal: 'Dọn sơ đồ',
    start: '/map',
    profile: 'employee',
    assertions: [{ text: 'Không bao giờ hiện' }],
    allowDestructive,
  };
  return Exploration.start(cfg, req, {
    browser,
    vars: VARS,
    store: TrustStore.open(dir),
  });
}

const ICON: FakeMove[] = [{ op: 'CLICK', target: '🗑' }, { op: 'BLOCKED' }];

describe('the request layer on a shared env', () => {
  it('stops the request of an icon-only control System 1 clicked, and the run ends destructive_blocked', async () => {
    const x = await explore(ICON, 'shared');
    const stop = await x.advance();
    expect(stop).toMatchObject({
      status: 'error',
      error: { kind: 'destructive_blocked' },
    });
    expect(JSON.stringify(stop)).toContain('/map/purge');
    expect(await requestsLeft()).toBe(1);
  });

  it('stops it for System 1 even when the run allows destructive actions', async () => {
    const x = await explore(ICON, 'shared', true);
    expect(await x.advance()).toMatchObject({
      status: 'error',
      error: { kind: 'destructive_blocked' },
    });
    expect(await requestsLeft()).toBe(1);
  });

  it('stops the same request when the orchestrator sends it, without allowDestructive', async () => {
    const x = await explore([{ op: 'BLOCKED' }], 'shared');
    expect((await x.advance()).status).toBe('escalated');
    const stop = await x.step({
      kind: 'click',
      target: { role: 'button', name: '🗑' },
    });
    expect(stop).toMatchObject({
      status: 'error',
      error: { kind: 'destructive_blocked' },
    });
    expect(await requestsLeft()).toBe(1);
  });

  it('lets the orchestrator send it with allowDestructive', async () => {
    const x = await explore([{ op: 'BLOCKED' }], 'shared', true);
    expect((await x.advance()).status).toBe('escalated');
    await x.step({ kind: 'click', target: { role: 'button', name: '🗑' } });
    await expect.poll(requestsLeft).toBe(0);
    expect((await x.finish()).status).toBe('failed');
  });
});

describe('the request layer on a local env', () => {
  it('lets every request through', async () => {
    const x = await explore(ICON, 'local');
    await x.advance();
    await expect.poll(requestsLeft).toBe(0);
    expect((await x.finish()).error?.kind).not.toBe('destructive_blocked');
  });
});
