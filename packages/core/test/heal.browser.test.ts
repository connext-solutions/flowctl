import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../src/config.js';
import { loadFlow, type Loc } from '../src/flow/index.js';
import { replayFlow } from '../src/replay.js';
import { createDriver } from '../src/system1/index.js';
import {
  StepError,
  takeSnapshot,
  type Performable,
} from '../src/browser/index.js';
import { onControl } from '../src/explore/index.js';
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

const RENAMED = [
  '# reviewed by QA',
  'name: renamed',
  'goal: Gửi đơn trống để thấy lỗi',
  'profile: employee',
  'start: /requests',
  'steps:',
  '  - click: { role: button, name: "Gửi đơn" }',
  'assertions:',
  '  - text: Vui lòng nhập lý do',
  '',
].join('\n');

async function setup(
  moves: FakeMove[],
): Promise<{ cfg: LoadedConfig; file: string }> {
  s1 = await startFakeSystem1(moves);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  const file = join(cfg.flowsPath, 'renamed.yaml');
  writeFileSync(file, RENAMED);
  return { cfg, file };
}

describe('replay with heal', () => {
  it('heals a renamed button and, once the caller accepts, writes back only its locator', async () => {
    const { cfg, file } = await setup([{ op: 'CLICK', target: 'Gửi' }]);
    const r = await replayFlow(cfg, loadFlow(file, PROFILES), {
      browser,
      system1: createDriver(cfg, 'local', VARS),
      acceptHeals: true,
    });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
    expect(r.healed).toEqual([0]);
    expect(r.heals).toEqual([
      {
        step: 0,
        from: 'button "Gửi đơn"',
        to: 'button "Gửi"',
        written: true,
      },
    ]);
    expect(
      readFileSync(join(r.evidence.dir, 'decisions.jsonl'), 'utf8'),
    ).toMatch(/"source":"heal".*"outcome":"heal step 0 with /);
    expect(r.system1).toMatchObject({ decisions: 1, costUsd: 'unknown' });
    expect(readFileSync(file, 'utf8')).toContain('# reviewed by QA');
    expect(loadFlow(file, PROFILES).parsedSteps[0]).toEqual({
      kind: 'click',
      target: { role: 'button', name: 'Gửi' },
    });
  });

  it('reports the heal but never writes it without the caller accepting it (#48)', async () => {
    const { cfg, file } = await setup([{ op: 'CLICK', target: 'Gửi' }]);
    const r = await replayFlow(cfg, loadFlow(file, PROFILES), {
      browser,
      system1: createDriver(cfg, 'local', VARS),
    });
    expect(r.status).toBe('passed');
    expect(r.heals).toEqual([
      {
        step: 0,
        from: 'button "Gửi đơn"',
        to: 'button "Gửi"',
        written: false,
      },
    ]);
    expect(readFileSync(file, 'utf8')).toBe(RENAMED);
  });

  it('fails like strict replay when System 1 is not confident', async () => {
    const { cfg, file } = await setup([{ op: 'CLICK', target: 'Gửi', p: 0.3 }]);
    const r = await replayFlow(cfg, loadFlow(file, PROFILES), {
      browser,
      system1: createDriver(cfg, 'local', VARS),
    });
    expect(r).toMatchObject({
      status: 'failed',
      failed: { step: 0, kind: 'not_found' },
      healed: [],
    });
    expect(readFileSync(file, 'utf8')).toBe(RENAMED);
  });
});

describe('replay with heal on a duplicated control (#24)', () => {
  it('does not write back a healed locator that matches two elements', async () => {
    for (let i = 0; i < 2; i++)
      await fetch(`${fixture.url}/api/requests`, {
        method: 'POST',
        headers: {
          cookie: 'role=employee',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'Trùng lặp', type: 'LEAVE' }),
      });
    const { cfg } = await setup([{ op: 'CLICK', target: 'Duyệt Trùng lặp' }]);
    const text = [
      'name: duplicated',
      'goal: Quản lý duyệt đơn trùng lặp',
      'profile: manager',
      'start: /approvals',
      'steps:',
      '  - click: { role: button, name: "Duyệt đơn cũ" }',
      'assertions:',
      '  - text: Đã duyệt đơn',
      '',
    ].join('\n');
    const file = join(cfg.flowsPath, 'duplicated.yaml');
    writeFileSync(file, text);
    const r = await replayFlow(cfg, loadFlow(file, PROFILES), {
      browser,
      system1: createDriver(cfg, 'local', VARS),
    });
    expect(r).toMatchObject({
      status: 'failed',
      failed: { step: 0, kind: 'not_found' },
      healed: [],
    });
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});

describe('onControl with a uniqueness check (heal write-back, #24)', () => {
  it('refuses a recorded locator that matches more than one element, before acting', async () => {
    const page = await (await browser.newContext()).newPage();
    await page.setContent(
      '<button onclick="this.textContent=\'clicked\'">Xóa</button><button>Xóa</button>',
    );
    const id = (await takeSnapshot(page)).controls.find(
      (c) => c.name === 'Xóa',
    )?.id;
    if (id === undefined) throw new Error('no control');
    const ctx = {
      page,
      values: {},
      exec: { testIdAttribute: 'data-testid', timeout: 1000, flowsRoot: '.' },
      templated: [],
    };
    const build = (target: Loc): Performable => ({ kind: 'click', target });
    await expect(
      onControl(ctx, id, undefined, build, { requireUnique: true }),
    ).rejects.toBeInstanceOf(StepError);
    expect(await page.locator('button').first().textContent()).toBe('Xóa');
    await page.context().close();
  });
});

describe('heal checks the driver against the run env (#15)', () => {
  it('refuses a driver allowed for another env, before System 1 is asked', async () => {
    const { cfg, file } = await setup([{ op: 'CLICK', target: 'Gửi' }]);
    const s1cfg = cfg.system1;
    if (s1cfg === undefined) throw new Error('fixture config has no system1');
    const other = createDriver(
      { ...cfg, system1: { ...s1cfg, allowedEnvs: ['staging'] } },
      'staging',
      VARS,
    );
    const r = await replayFlow(cfg, loadFlow(file, PROFILES), {
      browser,
      system1: other,
    });
    expect(r).toMatchObject({
      status: 'error',
      error: { kind: 'system1_not_allowed' },
    });
    expect(readFileSync(file, 'utf8')).toBe(RENAMED);
  });
});

describe('heal never turns a step into a destructive one (#48)', () => {
  it('refuses a control that looks destructive for a step whose name does not', async () => {
    await fetch(`${fixture.url}/api/requests`, {
      method: 'POST',
      headers: { cookie: 'role=employee', 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Bị dẫn dắt', type: 'LEAVE' }),
    });
    const { cfg } = await setup([{ op: 'CLICK', target: 'Duyệt Bị dẫn dắt' }]);
    const text = [
      'name: steered',
      'goal: Mở chi tiết đơn',
      'profile: manager',
      'start: /approvals',
      'steps:',
      '  - click: { role: button, name: "Xem chi tiết" }',
      'assertions:',
      '  - text: Phê duyệt',
      '',
    ].join('\n');
    const file = join(cfg.flowsPath, 'steered.yaml');
    writeFileSync(file, text);
    const r = await replayFlow(cfg, loadFlow(file, PROFILES), {
      browser,
      system1: createDriver(cfg, 'local', VARS),
      acceptHeals: true,
    });
    expect(r).toMatchObject({
      status: 'failed',
      failed: { step: 0, kind: 'not_found' },
      healed: [],
    });
    expect(
      readFileSync(join(r.evidence.dir, 'decisions.jsonl'), 'utf8'),
    ).toContain('looks destructive');
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
});
