import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../src/config.js';
import { findFlows, type Flow } from '../src/flow/index.js';
import { replayFlow } from '../src/replay.js';
import type { RunResult } from '../src/result.js';
import { initTrust, TrustStore } from '../src/trust/index.js';
import {
  PROFILES,
  copyFlows,
  fixtureConfig,
  seedProfiles,
  writeFlow,
} from './helpers.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/**
 * The request layer of a replay (ADR 0024 section 5, T1.3): on an env the trust store classes `shared`, a replay
 * sends no write and no destructive `GET` (no `destructiveConfirm` entry can authorise one yet) and ends
 * `error: destructive_blocked`; a read-only replay passes; on `local` nothing changes.
 */
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
beforeEach(async () => {
  await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
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

async function setup(
  envClass: 'shared' | 'local',
): Promise<{ cfg: LoadedConfig; store: TrustStore }> {
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  copyFlows(cfg);
  const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-replay-guard-')), 's');
  gitRepo(cfg.root);
  initTrust({
    storeDir: dir,
    key: testOwnerKey(),
    project: 'replay-guard',
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
  return { cfg, store: TrustStore.open(dir) };
}

const fixtureFlow = (cfg: LoadedConfig, name: string): Flow => {
  const [flow] = findFlows(cfg.flowsPath, PROFILES, { names: [name] });
  if (flow === undefined) throw new Error(`${name} missing`);
  return flow;
};

const PURGE = {
  name: 'clean-map',
  goal: 'Dọn sơ đồ',
  profile: 'employee',
  start: '/map',
  steps: [{ click: { role: 'button', name: '🗑' } }, { wait: 200 }],
  assertions: [{ text: 'Sơ đồ' }],
};

const READ_ONLY = {
  name: 'read-requests',
  goal: 'Xem đơn từ',
  profile: 'employee',
  start: '/requests',
  steps: [{ wait: 50 }],
  assertions: [{ text: 'Đơn từ' }],
};

const seedRequest = async (): Promise<void> => {
  const r = await fetch(`${fixture.url}/api/requests`, {
    method: 'POST',
    headers: { cookie: 'role=employee', 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'QA giữ lại', amount: 1 }),
  });
  expect(r.status).toBe(201);
};

const blocked = (r: RunResult): void => {
  expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('error');
  expect(r.error?.kind).toBe('destructive_blocked');
};

describe('replay on a shared env', () => {
  it('refuses the POST of a create flow, names the missing confirmation, and creates nothing', async () => {
    const { cfg, store } = await setup('shared');
    const r = await replayFlow(cfg, fixtureFlow(cfg, 'leave-submit'), {
      browser,
      store,
    });
    blocked(r);
    expect(r.error?.hint).toContain('POST');
    expect(r.error?.hint).toContain('/api/requests');
    expect(r.error?.hint).toContain('destructiveConfirm');
    expect(r.error?.hint).toContain('"leave-submit"');
    expect(await requestsLeft()).toBe(0);
  });

  it('refuses a side-effecting GET sent by an icon-only control', async () => {
    const { cfg, store } = await setup('shared');
    await seedRequest();
    const r = await replayFlow(cfg, writeFlow(cfg, PURGE), { browser, store });
    blocked(r);
    expect(r.error?.hint).toContain('/map/purge');
    expect(await requestsLeft()).toBe(1);
  });

  it('passes a read-only replay', async () => {
    const { cfg, store } = await setup('shared');
    const r = await replayFlow(cfg, writeFlow(cfg, READ_ONLY), {
      browser,
      store,
    });
    expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
  });
});

describe('replay on a local env', () => {
  it('sends the create and the side-effecting GET as before', async () => {
    const { cfg, store } = await setup('local');
    const submit = await replayFlow(cfg, fixtureFlow(cfg, 'leave-submit'), {
      browser,
      store,
    });
    expect(submit.status, JSON.stringify(submit.error ?? submit.failed)).toBe(
      'passed',
    );
    expect(await requestsLeft()).toBe(1);
    const purge = await replayFlow(cfg, writeFlow(cfg, PURGE), {
      browser,
      store,
    });
    expect(purge.status, JSON.stringify(purge.error ?? purge.failed)).toBe(
      'passed',
    );
    expect(await requestsLeft()).toBe(0);
  });
});
