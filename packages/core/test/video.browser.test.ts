import { statSync } from 'node:fs';
import { basename } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OVERLAY_TAG, narrate, overlayScript } from '../src/browser/index.js';
import { findFlows } from '../src/flow/index.js';
import { replayFlow } from '../src/replay.js';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import {
  PROFILES,
  copyFlows,
  fixtureConfig,
  seedProfiles,
  writeFlow,
} from './helpers.js';

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

/** Demo videos (ADR 0032): one file per profile, and an overlay no assertion or locator can see. */
describe('replay --video', () => {
  it('records one video per profile of the two-role flow, and the flow still passes', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    copyFlows(cfg);
    const [flow] = findFlows(cfg.flowsPath, PROFILES, {
      names: ['leave-approve'],
    });
    if (flow === undefined) throw new Error('flow missing');
    const r = await replayFlow(cfg, flow, { browser, video: true });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
    expect(r.evidence.videos?.map((v) => basename(v))).toEqual([
      'video-employee.webm',
      'video-manager.webm',
    ]);
    for (const v of r.evidence.videos ?? [])
      expect(statSync(v).size).toBeGreaterThan(10_000);
  }, 60_000);

  it('keeps the overlay out of text assertions: its step text is not page text', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const flow = writeFlow(cfg, {
      name: 'overlay-hidden',
      goal: 'g',
      profile: 'employee',
      start: '/requests',
      steps: [{ click: { role: 'button', name: 'Gửi' } }],
      assertions: [{ text: 'Step 1:' }],
    });
    const r = await replayFlow(cfg, flow, { browser, video: true });
    expect(r.status).toBe('failed');
    expect(r.evidence.videos).toHaveLength(1);
  }, 30_000);

  it('records nothing and adds no pause without the option', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const flow = writeFlow(cfg, {
      name: 'no-video',
      goal: 'g',
      profile: 'employee',
      start: '/requests',
      steps: [{ click: { role: 'button', name: 'Gửi' } }],
      assertions: [{ text: 'Vui lòng nhập lý do' }],
    });
    const r = await replayFlow(cfg, flow, { browser });
    expect(r.status).toBe('passed');
    expect(r.evidence.videos).toBeUndefined();
    expect(r.ms).toBeLessThan(5_000);
  });

  it('draws the overlay on the page while body text, locators and the accessibility tree miss it', async () => {
    const context = await browser.newContext({ baseURL: fixture.url });
    try {
      await context.addInitScript(overlayScript('demo-flow'));
      const page = await context.newPage();
      await page.goto('/login?as=employee');
      await narrate(page, 'Step 1:', 'Click button "Overlay marker"');
      expect(await page.locator(OVERLAY_TAG).count()).toBe(1);
      expect(await page.locator(OVERLAY_TAG).boundingBox()).not.toBeNull();
      expect(await page.evaluate(() => document.body.innerText)).not.toContain(
        'Overlay marker',
      );
      expect(await page.getByText('Overlay marker').count()).toBe(0);
      expect(await page.locator('html').ariaSnapshot()).not.toContain(
        'Overlay marker',
      );
    } finally {
      await context.close();
    }
  });
});
