import { existsSync, readFileSync } from 'node:fs';
import { chromium, type Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Exploration, type ExploreRequest } from '../../src/explore/index.js';
import { FlowError, loadFlow, type Assertion } from '../../src/flow/index.js';
import { saveAsGenerator } from '../../src/save.js';
import {
  startFakeSystem1,
  startFixture,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
import { PROFILES, VARS, exploreConfig, seedProfiles } from '../helpers.js';

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

const REQUEST: ExploreRequest = {
  goal: 'Gửi đơn nghỉ',
  start: '/requests',
  profile: 'employee',
  inputs: { reason: { value: 'Việc riêng {{uid}}' } },
  assertions: [{ text: 'Việc riêng {{uid}}' }],
};

const GENERATED: Assertion[] = [
  {
    text: 'Việc riêng {{uid}}',
    sourceRef: { kind: 'contract', ref: 'POST /api/requests', quote: 'a {{ b' },
  },
];

async function explored() {
  s1 = await startFakeSystem1([
    { op: 'TYPE_TEXT', target: 'Lý do', input: 'reason' },
    { op: 'CLICK', target: 'Gửi' },
    { op: 'DONE' },
  ]);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  const x = await Exploration.start(cfg, REQUEST, { browser, vars: VARS });
  await x.advance();
  return { cfg, x };
}

describe('saveAsGenerator', () => {
  it('writes derived: true, the generator origin and the sourceRef, and the flow replays unverified', async () => {
    const { cfg, x } = await explored();
    const r = await saveAsGenerator(
      cfg,
      x,
      { name: 'gen-flow', browser },
      GENERATED,
    );
    expect(r.saved, JSON.stringify(r.replay)).toBe(true);
    expect(r.replay.provenance).toBe('unverified');
    const flow = loadFlow(r.file ?? '', PROFILES);
    expect(flow.derived).toBe(true);
    expect(flow.recorded).toMatchObject({ origin: 'generator' });
    expect(flow.assertions[0]).toMatchObject({
      sourceRef: { kind: 'contract', quote: 'a {{ b' },
    });
  });

  it.each([
    ['an empty list', []],
    ['an assertion without a sourceRef', [{ text: 'x' }] as Assertion[]],
  ])('refuses %s and writes nothing', async (_n, assertions) => {
    const { cfg, x } = await explored();
    await expect(
      saveAsGenerator(cfg, x, { name: 'gen-bad', browser }, assertions),
    ).rejects.toBeInstanceOf(FlowError);
    expect(existsSync(`${cfg.flowsPath}/gen-bad.yaml`)).toBe(false);
  });

  it('keeps the file text free of any provenance claim only for the human door', async () => {
    const { cfg, x } = await explored();
    const r = await saveAsGenerator(
      cfg,
      x,
      { name: 'gen-text', browser },
      GENERATED,
    );
    expect(readFileSync(r.file ?? '', 'utf8')).toContain('derived: true');
  });
});
