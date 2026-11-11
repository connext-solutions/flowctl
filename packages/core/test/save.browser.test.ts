import { existsSync, readFileSync, rmSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { storageStatePath, type LoadedConfig } from '../src/config.js';
import { Exploration, type ExploreRequest } from '../src/explore/index.js';
import { FlowError, loadFlow } from '../src/flow/index.js';
import { replayFlow } from '../src/replay.js';
import { saveExploration } from '../src/save.js';
import {
  startFakeSystem1,
  startFixture,
  type FakeMove,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
import { PROFILES, VARS, exploreConfig, seedProfiles } from './helpers.js';

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

const SUBMIT: ExploreRequest = {
  goal: 'Gửi đơn nghỉ',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng {{uid}}' } },
  assertions: [
    { network: { method: 'POST', url: '/api/requests', status: 201 } },
    { text: 'Việc riêng {{uid}}' },
  ],
};
const MOVES: FakeMove[] = [
  { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
  { op: 'CLICK', target: 'Gửi' },
  { op: 'DONE' },
];

async function explored(
  moves: FakeMove[] = MOVES,
): Promise<{ cfg: LoadedConfig; x: Exploration }> {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  const x = await Exploration.start(cfg, SUBMIT, { browser, vars: VARS });
  await x.advance();
  return { cfg, x };
}

describe('saveExploration', () => {
  it('writes the flow after a model-free replay passes, keeping templates', async () => {
    const { cfg, x } = await explored();
    const r = await saveExploration(cfg, x, {
      name: 'submit-leave',
      tags: ['hrm'],
      browser,
    });
    expect(r.saved, JSON.stringify(r.replay)).toBe(true);
    expect(r.replay.status).toBe('passed');
    const file = r.file ?? '';
    expect(readFileSync(file, 'utf8')).toContain('Việc riêng {{uid}}');
    const flow = loadFlow(file, PROFILES);
    expect(flow.tags).toEqual(['hrm']);
    expect(flow.recorded).toMatchObject({ system1: 'fake-system1' });
    expect((await replayFlow(cfg, flow, { browser })).status).toBe('passed');
  });

  it('writes nothing when the confirming replay fails', async () => {
    const { cfg, x } = await explored();
    rmSync(storageStatePath(cfg, 'local', 'employee'));
    const r = await saveExploration(cfg, x, { name: 'no-session', browser });
    expect(r.saved).toBe(false);
    expect(r.replay).toMatchObject({
      status: 'error',
      error: { kind: 'profile_expired' },
    });
    expect(existsSync(`${cfg.flowsPath}/no-session.yaml`)).toBe(false);
  });

  it('refuses a run that did not pass and an invalid name', async () => {
    const { cfg, x } = await explored([{ op: 'BLOCKED' }]);
    await expect(
      saveExploration(cfg, x, { name: 'x', browser }),
    ).rejects.toBeInstanceOf(FlowError);
    await s1?.close();
    const ok = await explored();
    await expect(
      saveExploration(ok.cfg, ok.x, { name: '../evil', browser }),
    ).rejects.toBeInstanceOf(FlowError);
  });
});

const APPROVE: ExploreRequest = {
  goal: 'Gửi đơn rồi duyệt',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng {{uid}}' } },
  assertions: [
    {
      network: { method: 'PATCH', url: '/api/requests/*/approve', status: 200 },
    },
    { text: 'Đã duyệt đơn' },
  ],
};
const TO_APPROVALS = [
  { kind: 'as', profile: 'manager' },
  { kind: 'goto', url: '/approvals' },
] as const;

describe('saveExploration with orchestrator steps', () => {
  it('turns a uid copied from the controls table back into {{uid}} so the save replays', async () => {
    await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
    s1 = await startFakeSystem1([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'CLICK', target: 'Gửi' },
      { op: 'BLOCKED' },
      { op: 'BLOCKED' },
      { op: 'DONE' },
    ]);
    const cfg = exploreConfig(fixture.url, s1.url);
    await seedProfiles(cfg, fixture.url);
    const x = await Exploration.start(cfg, APPROVE, { browser, vars: VARS });
    expect((await x.advance()).status).toBe('escalated');
    const stop = await x.step([...TO_APPROVALS]);
    if (stop.status !== 'escalated') throw new Error(JSON.stringify(stop));
    const label = stop.escalation.controls.find((c) =>
      c.includes('Duyệt Việc riêng'),
    );
    const uid = /Việc riêng (\w+)"/.exec(label ?? '')?.[1] ?? '';
    expect(uid).toMatch(/^[0-9a-f]{8}$/);
    const done = await x.step({
      kind: 'click',
      target: { role: 'button', name: `Duyệt Việc riêng ${uid}` },
    });
    expect(done.status, JSON.stringify(done)).toBe('passed');
    const r = await saveExploration(cfg, x, { name: 'approve-uid', browser });
    expect(r.saved, JSON.stringify(r.replay)).toBe(true);
    const yaml = readFileSync(r.file ?? '', 'utf8');
    expect(yaml).toContain('Duyệt Việc riêng {{uid}}');
    expect(yaml).not.toContain(uid);
  });

  it('saves a recorded name containing {{env.org}} escaped and replays it literally', async () => {
    await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
    const reason = 'Tổng {{env.org}} {{today}}';
    s1 = await startFakeSystem1([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'CLICK', target: 'Gửi' },
      { op: 'BLOCKED' },
      { op: 'CLICK', target: `Duyệt ${reason}` },
      { op: 'DONE' },
    ]);
    const cfg = exploreConfig(fixture.url, s1.url, {
      envs: {
        local: {
          baseUrl: fixture.url,
          loginUrl: '/login',
          vars: { org: 'SPLICED' },
        },
      },
    });
    await seedProfiles(cfg, fixture.url);
    const x = await Exploration.start(
      cfg,
      {
        ...APPROVE,
        inputs: {
          reason: { value: 'Tổng {{lbrace}}env.org}} {{lbrace}}today}}' },
        },
      },
      { browser, vars: VARS },
    );
    expect((await x.advance()).status).toBe('escalated');
    const stop = await x.step([...TO_APPROVALS]);
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
    const r = await saveExploration(cfg, x, {
      name: 'approve-braces',
      browser,
    });
    expect(r.saved, JSON.stringify(r.replay)).toBe(true);
    const yaml = readFileSync(r.file ?? '', 'utf8');
    expect(yaml).toContain('Duyệt Tổng {{lbrace}}env.org}} {{lbrace}}today}}');
    expect(yaml).not.toContain('SPLICED');
    const flow = loadFlow(r.file ?? '', PROFILES);
    expect((await replayFlow(cfg, flow, { browser })).status).toBe('passed');
  });
});
