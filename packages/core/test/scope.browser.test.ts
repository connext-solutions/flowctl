import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LoadedConfig } from '../src/config.js';
import { DRAFT_PROVENANCE, RunSession } from '../src/run/index.js';
import { initTrust, TrustStore } from '../src/trust/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/**
 * The scope guard on the fixture app's `/map` decoys (ADR 0024 section 3, T1.2): each case starts a run on `/map`,
 * acts on one decoy, and expects the run to end `scope_violation` rather than reach it.
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

const FLOW = {
  name: 'scope-flow',
  goal: 'g',
  profile: 'employee',
  start: '/map',
  steps: [{ wait: 10 }],
  assertions: [{ text: 'Sơ đồ' }],
};

async function open(
  extra: Record<string, unknown> = {},
  store?: TrustStore,
): Promise<RunSession> {
  const cfg = fixtureConfig(fixture.url, extra);
  await seedProfiles(cfg, fixture.url);
  const run = RunSession.open(cfg, writeFlow(cfg, FLOW), {
    provenance: DRAFT_PROVENANCE,
    browser,
    store,
  });
  await run.begin();
  return run;
}

const click = (run: RunSession, role: 'link' | 'button', name: string) =>
  run.perform({ kind: 'click', target: { role, name } });

const kindOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error && 'kind' in e ? String(e.kind) : String(e);
  }
  return undefined;
};

describe('scope guard on the /map decoys', () => {
  it('lets a run in scope pass', async () => {
    const run = await open();
    expect((await run.check()).passed).toBe(true);
    await run.finish({ status: 'passed' }, 0);
  });

  it.each([
    ['link', 'Trang ngoài', 'protocol-relative //host link'],
    ['link', 'Tên miền giống', 'subdomain-suffix host'],
    ['button', 'Gửi ra ngoài', 'cross-origin form action'],
  ] as const)(
    'stops a %s "%s" (%s) before it leaves the browser',
    async (role, name, _why) => {
      const run = await open();
      expect(await kindOf(click(run, role, name))).toBe('scope_violation');
      expect(new URL(run.page.url()).hostname).not.toContain('evil.example');
      await run.finish({ status: 'passed' }, 0);
    },
  );

  it('detects a redirect hop to another origin', async () => {
    const run = await open();
    const r = await kindOf(click(run, 'link', 'Chuyển hướng'));
    expect(r).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });

  it('refuses a denied path reached through a double-encoded traversal', async () => {
    const run = await open({ target: { scope: { deny: ['/admin/**'] } } });
    expect(await kindOf(click(run, 'link', 'Đường dẫn mã hoá'))).toBe(
      'scope_violation',
    );
    await run.finish({ status: 'passed' }, 0);
  });

  it('detects a hash route to a denied path, which sends no request', async () => {
    const run = await open({ target: { scope: { deny: ['/admin/**'] } } });
    expect(await kindOf(click(run, 'link', 'Cài đặt (hash)'))).toBe(
      'scope_violation',
    );
    await run.finish({ status: 'passed' }, 0);
  });

  it('holds a popup to the same scope as its opener', async () => {
    const run = await open({
      target: { scope: { allow: ['/map', '/requests', '/approvals'] } },
    });
    await click(run, 'button', 'Mở popup').catch(() => undefined);
    expect(await kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });

  it('stops a fetch and a WebSocket to another origin, and a denied path on the env origin', async () => {
    for (const script of [
      "fetch('https://evil.example/x').catch(() => {})",
      "new WebSocket('wss://evil.example/socket')",
      "fetch('/auth/logout').catch(() => {})",
    ]) {
      const run = await open();
      await run.page.evaluate(script);
      expect(await kindOf(run.check(1000)), script).toBe('scope_violation');
      await run.finish({ status: 'passed' }, 0);
    }
  });

  it('aborts out-of-scope requests before they leave: a second local server sees none', async () => {
    let hits = 0;
    const other = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.end('x');
    });
    await new Promise<void>((r) => other.listen(0, 'localhost', r));
    const address = other.address();
    const port =
      typeof address === 'object' && address !== null ? address.port : 0;
    const there = `http://localhost:${port}`;
    try {
      for (const script of [
        `fetch('${there}/x').catch(() => {})`,
        `navigator.sendBeacon('${there}/b', 'x')`,
        `new Image().src = '${there}/i.png'`,
        `location.href = '${there}/page'`,
        `document.body.append(Object.assign(document.createElement('iframe'), { src: '${there}/frame' }))`,
        `new EventSource('${there}/events')`,
        `new WebSocket('${there.replace('http', 'ws')}/socket')`,
      ]) {
        const run = await open();
        await run.page.evaluate(script).catch(() => undefined);
        expect(await kindOf(run.check(1000)), script).toBe('scope_violation');
        await run.finish({ status: 'passed' }, 0);
      }
      expect(hits).toBe(0);
    } finally {
      await new Promise((r) => other.close(r));
    }
  });

  it('ends a run scope_violation, not failed, when a blocked request makes a later step fail', async () => {
    const run = await open();
    await run.page.evaluate(
      "fetch('https://evil.example/api').catch(() => {})",
    );
    await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
    expect(
      await kindOf(
        run.perform({
          kind: 'click',
          target: { role: 'button', name: 'Không có' },
        }),
      ),
    ).toBe('scope_violation');
    const result = await run.finish({ status: 'passed' }, 0);
    expect(result).toMatchObject({
      status: 'error',
      error: { kind: 'scope_violation' },
    });
  });

  it('keeps a failed navigation app_unreachable, not a scope violation', async () => {
    const cfg = fixtureConfig('http://127.0.0.1:9');
    await seedProfiles(cfg, fixture.url);
    const run = RunSession.open(cfg, writeFlow(cfg, FLOW), {
      provenance: DRAFT_PROVENANCE,
      browser,
    });
    expect(await kindOf(run.begin())).toBe('app_unreachable');
    await run.finish({ status: 'passed' }, 0);
  });

  it('blocks service workers on every run context', async () => {
    const run = await open();
    const registered = await run.page.evaluate(() =>
      navigator.serviceWorker
        .getRegistrations()
        .then((r) => r.length)
        .catch(() => 0),
    );
    expect(registered).toBe(0);
    await run.finish({ status: 'passed' }, 0);
  });

  it('refuses a run whose env is on a production host, before the start page opens', async () => {
    const cfg: LoadedConfig = fixtureConfig(fixture.url);
    mkdirSync(cfg.flowsPath, { recursive: true });
    gitRepo(cfg.root);
    const storeDir = join(mkdtempSync(join(tmpdir(), 'flowctl-store-')), 's');
    initTrust({
      storeDir,
      key: testOwnerKey(),
      project: 'test-project',
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      answers: {
        envs: { local: { origin: fixture.url, class: 'local' } },
        productionOrigins: ['https://127.0.0.1'],
        defaultEnv: 'local',
        language: 'vi',
        locale: 'vi-VN',
      },
      anchorDir: testAnchorDir(),
    });
    await seedProfiles(cfg, fixture.url);
    const run = RunSession.open(cfg, writeFlow(cfg, FLOW), {
      provenance: DRAFT_PROVENANCE,
      browser,
      store: TrustStore.open(storeDir),
    });
    expect(await kindOf(run.begin())).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });
});
