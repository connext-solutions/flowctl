import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { runsPath, type LoadedConfig } from '../src/config.js';
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
afterEach(async () => {
  await s1?.close();
  s1 = undefined;
});

async function setup(
  moves: FakeMove[],
  extra: Record<string, unknown> = {},
): Promise<LoadedConfig> {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url, extra);
  await seedProfiles(cfg, fixture.url);
  return cfg;
}

const SUBMIT: ExploreRequest = {
  goal: 'Gửi đơn nghỉ với lý do có sẵn',
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
    { text: 'Đã gửi đơn' },
  ],
};

async function explore(cfg: LoadedConfig, req: ExploreRequest = SUBMIT) {
  const x = await Exploration.start(cfg, req, { browser, vars: VARS });
  return { x, stop: await x.advance() };
}

describe('Exploration', () => {
  it('passes as soon as the assertions hold and records replayable steps', async () => {
    const cfg = await setup([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'CLICK', target: 'Gửi' },
      { op: 'DONE' },
    ]);
    const { x, stop } = await explore(cfg);
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
    expect(x.recording()?.steps).toEqual([
      {
        kind: 'fill',
        target: { role: 'textbox', name: 'Lý do' },
        input: 'reason',
      },
      { kind: 'click', target: { role: 'button', name: 'Gửi' } },
    ]);
  });

  it('logs every System 1 decision to decisions.jsonl in the run directory', async () => {
    const cfg = await setup([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'DONE', second: { op: 'CLICK', target: 'Gửi' } },
    ]);
    const { stop } = await explore(cfg);
    if (stop.status !== 'passed') throw new Error(JSON.stringify(stop));
    const lines = readFileSync(
      join(stop.evidence.dir, 'decisions.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n')
      .map((l): unknown => JSON.parse(l));
    expect(lines.length).toBe(s1?.requests.length);
    expect(lines[0]).toMatchObject({
      source: 'explore',
      step: 0,
      ranked: expect.arrayContaining([{ op: 'TYPE_TEXT', p: 0.9 }]),
      targets: { TYPE_TEXT: { control: expect.stringContaining('"Lý do"') } },
      input: { key: 'reason' },
      outcome: expect.stringMatching(/^act TYPE_TEXT /),
    });
    expect(lines[1]).toMatchObject({
      outcome: expect.stringMatching(/^act CLICK .*after DONE rejected 1\/3$/),
    });
  });

  it('rejects DONE while the assertions fail and runs the runner-up', async () => {
    const cfg = await setup([
      { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
      { op: 'DONE', second: { op: 'CLICK', target: 'Gửi' } },
    ]);
    const { x, stop } = await explore(cfg);
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
    expect(x.recording()?.steps.at(-1)).toEqual({
      kind: 'click',
      target: { role: 'button', name: 'Gửi' },
    });
  });

  it('escalates done_rejected after three rejected DONEs, with the failing assertion', async () => {
    const cfg = await setup([{ op: 'DONE', second: { op: 'WAIT' } }], {
      assertTimeout: 500,
    });
    const { stop } = await explore(cfg);
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'done_rejected' },
      failed: { assertion: { network: { method: 'POST' } } },
    });
  });

  it('writes the network and console logs at an escalation, before anyone finishes the run (H0.1)', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }]);
    const { x, stop } = await explore(cfg);
    expect(stop.status).toBe('escalated');
    const dir = join(runsPath(cfg), stop.runId);
    expect(existsSync(join(dir, 'network.json'))).toBe(true);
    expect(existsSync(join(dir, 'console.json'))).toBe(true);
    expect(existsSync(join(dir, 'run.json'))).toBe(false);
    await x.finish();
    expect(existsSync(join(dir, 'run.json'))).toBe(true);
  });

  it('escalates BLOCKED with the control table', async () => {
    const cfg = await setup([{ op: 'BLOCKED' }]);
    const { stop } = await explore(cfg);
    if (stop.status !== 'escalated') throw new Error(JSON.stringify(stop));
    expect(stop.escalation.reason).toBe('BLOCKED');
    expect(stop.escalation.controls).toContainEqual(
      expect.stringMatching(/^\[\d+\] button "Gửi"$/),
    );
  });

  it('escalates low confidence', async () => {
    const cfg = await setup([{ op: 'CLICK', target: 'Gửi', p: 0.3 }]);
    const { stop } = await explore(cfg);
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'low_confidence' },
    });
  });

  it('escalates a loop: the same action three times without changing the page', async () => {
    const cfg = await setup([{ op: 'CLICK', target: 'Lưu nháp' }]);
    const { stop } = await explore(cfg, {
      goal: 'Lưu nháp',
      start: '/lab',
      profile: 'employee',
      assertions: [{ text: 'Không bao giờ hiện' }],
    });
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'loop' },
      steps: 4,
    });
  });

  it('escalates max_steps', async () => {
    const cfg = await setup([{ op: 'WAIT' }]);
    const { stop } = await explore(cfg, { ...SUBMIT, maxSteps: 2 });
    expect(stop).toMatchObject({
      status: 'escalated',
      escalation: { reason: 'max_steps' },
      steps: 2,
    });
  });

  it('refuses System 1 outside allowedEnvs', async () => {
    const cfg = await setup([{ op: 'DONE' }], {
      system1: { baseUrl: 'http://127.0.0.1:9', allowedEnvs: ['staging'] },
    });
    const { stop } = await explore(cfg);
    expect(stop).toMatchObject({
      status: 'error',
      error: { kind: 'system1_not_allowed' },
    });
  });

  it('does not run teardown when System 1 is refused before the run starts (#22)', async () => {
    const cfg = await setup([{ op: 'DONE' }], {
      system1: { baseUrl: 'http://127.0.0.1:9', allowedEnvs: ['staging'] },
    });
    const { stop } = await explore(cfg, { ...SUBMIT, teardown: 'touch torn' });
    expect(stop).toMatchObject({ error: { kind: 'system1_not_allowed' } });
    expect(existsSync(join(cfg.root, 'torn'))).toBe(false);
  });

  it('reports an unreachable System 1 as an error', async () => {
    const cfg = await setup([{ op: 'DONE' }], {
      system1: { baseUrl: 'http://127.0.0.1:9', allowedEnvs: ['local'] },
    });
    const { stop } = await explore(cfg);
    expect(stop).toMatchObject({
      status: 'error',
      error: { kind: 'system1_unreachable' },
    });
  });

  it('finish() gives the assertion verdict of an escalated run', async () => {
    const cfg = await setup(
      [
        { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
        { op: 'BLOCKED' },
      ],
      { assertTimeout: 500 },
    );
    const { x } = await explore(cfg);
    const r = await x.finish();
    expect(r).toMatchObject({ status: 'failed' });
    expect(x.recording()).toBeUndefined();
  });
});
