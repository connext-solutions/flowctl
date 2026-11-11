import { existsSync, readFileSync } from 'node:fs';
import {
  DECOYS,
  GUARD_PAGES,
  startFixture,
  type Fixture,
} from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LoadedConfig } from '../src/config.js';
import { AppMapSchema, observe, type AppMap } from '../src/observe/index.js';
import { fixtureConfig, seedProfiles } from './helpers.js';

/**
 * The deterministic crawler (T2.2) on the fixture's `/map` (T2.6): it finds the pages, stays in scope, never sends
 * anything but a read, never follows a decoy, respects the page and wall-clock caps, and maps the same app the same
 * way twice.
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

async function config(
  extra: Record<string, unknown> = {},
): Promise<LoadedConfig> {
  const cfg = fixtureConfig(fixture.url, {
    target: { scope: { deny: ['/admin/**'] }, ...extra },
  });
  await seedProfiles(cfg, fixture.url);
  return cfg;
}

const paths = (m: AppMap): string[] => m.pages.map((p) => p.path);
const page = (m: AppMap, path: string) => {
  const found = m.pages.find((p) => p.path === path);
  if (found === undefined) throw new Error(`no page ${path}`);
  return found;
};

describe('observe (T2.2)', () => {
  it('finds the pages of /map breadth-first, in sorted order, with their status, links and forms', async () => {
    const cfg = await config();
    const { map, run, file, budget } = await observe(cfg, {
      browser,
      start: '/map',
    });
    expect(run.status).toBe('passed');
    expect(budget).toEqual({
      pages: { used: 5, max: 50 },
      wallClockMs: 600_000,
      costUsd: 'unknown',
    });
    expect(paths(map)).toEqual([
      '/map',
      '/map/help',
      '/map/hop',
      '/map/report',
      '/requests',
    ]);
    expect(map.truncated).toBe(false);
    expect(map.origin).toBe(fixture.url);
    const start = page(map, '/map');
    expect(start).toMatchObject({ title: 'Sơ đồ', status: 200, refused: [] });
    expect(start.links).toEqual([
      '/admin/settings',
      '/approvals',
      '/map',
      '/map/%252e%252e/admin',
      '/map/help',
      '/map/hop',
      '/map/popup',
      '/map/purge',
      '/map/report',
      '/requests',
    ]);
    expect(start.controls).toContainEqual({ role: 'link', name: 'Báo cáo' });
    expect(start.forms).toEqual([
      {
        name: null,
        submit: 'Gửi ra ngoài',
        fields: [
          {
            role: 'textbox',
            name: 'Từ khoá ngoài',
            type: null,
            required: false,
          },
        ],
      },
    ]);
    expect(page(map, '/requests').forms).toEqual([
      {
        name: null,
        submit: 'Gửi',
        fields: [
          { role: 'textbox', name: 'Lý do', type: null, required: true },
          { role: 'textbox', name: 'Số tiền', type: null, required: false },
          { role: 'combobox', name: 'Nhân viên', type: null, required: false },
        ],
      },
    ]);
    expect(page(map, '/map/hop')).toMatchObject({
      status: 0,
      refused: ['scope_violation'],
    });
    expect(existsSync(file)).toBe(true);
    expect(AppMapSchema.parse(JSON.parse(readFileSync(file, 'utf8')))).toEqual(
      map,
    );
  });

  it('stays in scope: sends only GETs and never opens a decoy, a denied path or a destructive link', async () => {
    const cfg = await config();
    const before = fixture.requests.length;
    await observe(cfg, { browser, start: '/map' });
    const sent = fixture.requests.slice(before);
    expect(sent.filter((r) => r.method !== 'GET')).toEqual([]);
    const opened = new Set(sent.map((r) => r.path));
    for (const never of [
      DECOYS.offScope,
      DECOYS.popup,
      DECOYS.sideEffectGet,
      DECOYS.serviceWorker,
      '/approvals',
      '/admin',
      '/x',
    ])
      expect(opened.has(never), never).toBe(false);
  });

  it('maps the same app the same way twice', async () => {
    const cfg = await config();
    const a = await observe(cfg, { browser, start: '/map' });
    const b = await observe(cfg, { browser, start: '/map' });
    expect({ ...b.map, observedAt: '' }).toEqual({ ...a.map, observedAt: '' });
  });

  it('stops at the page budget and marks the map truncated', async () => {
    const cfg = await config({ budgets: { pages: 2 } });
    const { map, run, budget } = await observe(cfg, { browser, start: '/map' });
    expect(paths(map)).toEqual(['/map', '/map/help']);
    expect(map.truncated).toBe(true);
    expect(run.status).toBe('passed');
    expect(budget).toMatchObject({
      pages: { used: 2, max: 2 },
      stoppedBy: 'pages',
      costUsd: 'unknown',
    });
  });

  it('stops at the wall-clock budget: the run ends budget_exceeded and the map is truncated', async () => {
    const cfg = await config({ budgets: { wallClockMs: 1 } });
    const { map, run, budget } = await observe(cfg, { browser, start: '/map' });
    expect(run.error?.kind).toBe('budget_exceeded');
    expect(map.truncated).toBe(true);
    expect(budget).toMatchObject({ wallClockMs: 1, stoppedBy: 'wallClock' });
  });

  it('refuses a start that is not a path, an unknown profile, and a denied start page', async () => {
    const cfg = await config();
    await expect(
      observe(cfg, { browser, start: 'https://evil.example/' }),
    ).rejects.toThrow(/start must be a path/);
    await expect(observe(cfg, { browser, profile: 'nobody' })).rejects.toThrow(
      /unknown profile/,
    );
    const denied = await observe(cfg, { browser, start: '/admin/settings' });
    expect(denied.run.error?.kind).toBe('scope_violation');
    expect(denied.map.pages).toEqual([]);
  });

  it('ends profile_expired when a page routes itself to the login page after it loaded (an SPA on 401)', async () => {
    const cfg = await config();
    const { map, run } = await observe(cfg, {
      browser,
      start: GUARD_PAGES.spaLogin,
    });
    expect(run.error?.kind).toBe('profile_expired');
    expect(run.error?.hint).toContain('flowctl login employee --env local');
    expect(map.pages).toEqual([]);
    expect(map.truncated).toBe(true);
  });
});
