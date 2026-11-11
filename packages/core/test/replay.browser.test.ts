import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runsPath } from '../src/config.js';
import { findFlows } from '../src/flow/index.js';
import { exitCodeFor, replayFlow, replayMany } from '../src/replay.js';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import {
  PROFILES,
  copyFlows,
  fixtureConfig,
  seedProfiles,
  writeFlow,
} from './helpers.js';
import { consentHooks, testStore } from './trust-fixture.js';

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

async function ready(extra: Record<string, unknown> = {}) {
  const cfg = fixtureConfig(fixture.url, extra);
  await seedProfiles(cfg, fixture.url);
  copyFlows(cfg);
  return cfg;
}

const simple = (over: Record<string, unknown>) => ({
  name: 'simple',
  goal: 'g',
  profile: 'employee',
  start: '/requests',
  steps: [{ click: { role: 'button', name: 'Gửi' } }],
  assertions: [{ text: 'Vui lòng nhập lý do' }],
  ...over,
});

describe('replayFlow', () => {
  it('passes the two-role happy flow and writes evidence', async () => {
    const cfg = await ready();
    const [flow] = findFlows(cfg.flowsPath, PROFILES, {
      names: ['leave-approve'],
    });
    if (flow === undefined) throw new Error('flow missing');
    const r = await replayFlow(cfg, flow, { browser });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
    expect(r.steps).toBe(9);
    expect(r.evidence.traces.map((t) => t.split('/').pop())).toEqual([
      'trace-employee.zip',
      'trace-manager.zip',
    ]);
    expect(existsSync(join(r.evidence.dir, 'run.json'))).toBe(true);
    expect(r.weakLocators).toEqual([]);
  });

  it('expands env vars in the start page and steps', async () => {
    const cfg = await ready({
      envs: {
        local: {
          baseUrl: fixture.url,
          loginUrl: '/login',
          vars: { page: '/requests' },
        },
      },
    });
    const flow = writeFlow(
      cfg,
      simple({
        name: 'env-vars',
        start: '{{env.page}}',
        steps: [
          { goto: '{{env.page}}' },
          { click: { role: 'button', name: 'Gửi' } },
        ],
      }),
    );
    const r = await replayFlow(cfg, flow, { browser });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
  });

  it('gives page loads navigationTimeout, not stepTimeout', async () => {
    const cfg = await ready({ stepTimeout: 500, navigationTimeout: 5000 });
    const flow = writeFlow(
      cfg,
      simple({ name: 'slow-load', start: '/requests?delay=1500' }),
    );
    const r = await replayFlow(cfg, flow, { browser });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
  });

  it('passes the negative flow', async () => {
    const cfg = await ready();
    const [flow] = findFlows(cfg.flowsPath, PROFILES, {
      names: ['leave-validation'],
    });
    if (flow === undefined) throw new Error('flow missing');
    expect((await replayFlow(cfg, flow, { browser })).status).toBe('passed');
  });

  it('fails on a step that matches nothing, without verifying, and still runs teardown', async () => {
    const cfg = await ready();
    const flow = writeFlow(
      cfg,
      simple({
        steps: [{ click: { role: 'button', name: 'Không có' } }],
        teardown: 'false',
      }),
    );
    const store = consentHooks(cfg, testStore(cfg), [flow]);
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.status).toBe('failed');
    expect(r.failed).toMatchObject({ step: 0, kind: 'not_found' });
    expect(r.teardownFailed).toBe(true);
  });

  it('reports a failing assertion with what it got', async () => {
    const cfg = await ready();
    const r = await replayFlow(
      cfg,
      writeFlow(cfg, simple({ assertions: [{ text: 'Không bao giờ có' }] })),
      { browser },
    );
    expect(r.status).toBe('failed');
    expect(r.failed).toMatchObject({ assertion: { text: 'Không bao giờ có' } });
  });

  it('turns a failing setup into an error and a failing teardown into a flag', async () => {
    const cfg = await ready();
    const f1 = writeFlow(
      cfg,
      simple({ name: 'setup-down', setup: 'echo db down >&2; exit 1' }),
    );
    const f2 = writeFlow(
      cfg,
      simple({ name: 'teardown-down', teardown: 'exit 1' }),
    );
    const store = consentHooks(cfg, testStore(cfg), [f1, f2]);
    const r1 = await replayFlow(cfg, f1, { browser, store });
    expect(r1).toMatchObject({
      status: 'error',
      error: { kind: 'setup_failed', hint: 'db down' },
    });
    const r2 = await replayFlow(cfg, f2, { browser, store });
    expect(r2.status).toBe('passed');
    expect(r2.teardownFailed).toBe(true);
  });

  it('reports a missing saved session as profile_expired with the login command', async () => {
    const cfg = fixtureConfig(fixture.url);
    const r = await replayFlow(cfg, writeFlow(cfg, simple({})), { browser });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('profile_expired');
    expect(r.error?.hint).toContain('flowctl login employee --env local');
  });

  it('flags unnamed locators as weak', async () => {
    const cfg = await ready();
    const flow = writeFlow(
      cfg,
      simple({
        steps: [
          { click: { role: 'button', name: 'Gửi' } },
          { hover: { role: 'table' } },
        ],
      }),
    );
    expect((await replayFlow(cfg, flow, { browser })).weakLocators).toEqual([
      'table name=""',
    ]);
  });

  it('keeps only runsRetention run directories', async () => {
    const cfg = await ready({ runsRetention: 2 });
    const flow = writeFlow(cfg, simple({}));
    for (let i = 0; i < 3; i++) await replayFlow(cfg, flow, { browser });
    expect(
      readdirSync(runsPath(cfg)).filter((n) => n.startsWith('r_')),
    ).toHaveLength(2);
  });
});

describe('replayMany', () => {
  it('repeats each flow', async () => {
    const cfg = await ready();
    const flows = findFlows(cfg.flowsPath, PROFILES, { tag: 'negative' });
    const s = await replayMany(cfg, flows, { repeat: 2 });
    expect(s.results).toHaveLength(2);
    expect(s.flows).toEqual([
      {
        flow: 'leave-validation',
        runs: 2,
        statuses: ['passed', 'passed'],
        flaky: false,
      },
    ]);
    expect(exitCodeFor(s)).toBe(0);
  });
});
