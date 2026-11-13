import {
  chmodSync,
  copyFileSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ConfigError, storageStatePath } from '../src/config.js';
import { outcomeOf, toOutcome } from '../src/run/index.js';
import { fixtureConfig, openRun, seedProfiles, writeFlow } from './helpers.js';
import { allowEnvVars, testStore } from './trust-fixture.js';

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
  name: 'session-flow',
  goal: 'g',
  profile: 'employee',
  start: '/requests',
  steps: [{ click: { role: 'button', name: 'Gửi' } }],
  assertions: [{ text: 'x' }],
};

describe('RunSession', () => {
  it('opens without touching the browser, then begins at the start page', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    expect(browser.contexts()).toHaveLength(0);
    expect(() => run.steps).toThrow(/begin/);
    await run.begin();
    expect(run.page.url()).toBe(`${fixture.url}/requests`);
    expect(run.steps.map((s) => s.kind)).toEqual(['click']);
    const r = await run.finish({ status: 'passed' }, 1);
    expect(r).toMatchObject({
      runId: run.runId,
      flow: 'session-flow',
      env: 'local',
      status: 'passed',
      steps: 1,
    });
    expect(browser.contexts()).toHaveLength(0);
  });

  it('switches profile with evidence attached and reuses an open context', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    await run.begin();
    await run.perform({ kind: 'as', profile: 'manager', goto: '/approvals' });
    expect(run.page.url()).toBe(`${fixture.url}/approvals`);
    await expect
      .poll(() => run.evidence.network.some((e) => e.profile === 'manager'))
      .toBe(true);
    await run.perform({ kind: 'as', profile: 'employee' });
    expect(run.page.url()).toBe(`${fixture.url}/requests`);
    const r = await run.finish({ status: 'passed' }, 0);
    expect(r.evidence.traces.map((t) => t.split('/').pop())).toEqual([
      'trace-employee.zip',
      'trace-manager.zip',
    ]);
    expect(existsSync(join(r.evidence.dir, 'run.json'))).toBe(true);
  });

  it('opens a profile switch with a page directly at that page', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    await run.begin();
    const oneLoad = await run.page.evaluate(() => history.length);
    await run.perform({ kind: 'as', profile: 'manager', goto: '/approvals' });
    expect(run.page.url()).toBe(`${fixture.url}/approvals`);
    expect(await run.page.evaluate(() => history.length)).toBe(oneLoad);
    await run.finish({ status: 'passed' }, 0);
  });

  it('reports a goto that lands on the login page as profile_expired', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    await run.begin();
    await expect(
      run.perform({ kind: 'goto', url: '/login' }),
    ).rejects.toMatchObject({ kind: 'profile_expired' });
    await run.finish({ status: 'passed' }, 0);
  });

  it.each(['file:///etc/passwd', 'https://example.com/', '//example.com/x'])(
    'refuses to navigate to %s before asking the browser (#45)',
    async (url) => {
      const cfg = fixtureConfig(fixture.url);
      await seedProfiles(cfg, fixture.url);
      const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
      await run.begin();
      const before = run.ctx().page.url();
      await expect(run.perform({ kind: 'goto', url })).rejects.toMatchObject({
        kind: 'flow_invalid',
      });
      expect(run.ctx().page.url()).toBe(before);
      await run.finish({ status: 'passed' }, 0);
    },
  );

  it('performs actions in the active page and checks assertions', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const run = openRun(
      cfg,
      writeFlow(cfg, {
        ...FLOW,
        assertions: [{ text: 'Vui lòng nhập lý do' }],
      }),
      { browser },
    );
    await run.begin();
    expect((await run.check(0)).passed).toBe(false);
    expect((await run.snapshot()).controls.map((c) => c.name)).toContain('Gửi');
    await run.perform({
      kind: 'click',
      target: { role: 'button', name: 'Gửi' },
    });
    expect((await run.check()).passed).toBe(true);
    const { page, ...rest } = run.ctx();
    expect(page).toBe(run.page);
    expect(rest).toEqual({
      values: run.values,
      exec: {
        testIdAttribute: cfg.testIdAttribute,
        timeout: cfg.stepTimeout,
        flowsRoot: cfg.flowsPath,
        secrets: [],
      },
      templated: [{ value: run.templates.uid, template: '{{uid}}' }],
    });
    await run.finish({ status: 'passed' }, 1);
  });

  it('masks a secret input in the result and in run.json (invariant 4)', async () => {
    process.env['FLOWCTL_TEST_SECRET'] = 'hunter2-"quoted"';
    try {
      const cfg = fixtureConfig(fixture.url);
      await seedProfiles(cfg, fixture.url);
      const flow = writeFlow(cfg, {
        ...FLOW,
        inputs: { pw: { env: 'FLOWCTL_TEST_SECRET' } },
        steps: [{ fill: { role: 'textbox', name: 'Lý do' }, input: 'pw' }],
        assertions: [
          {
            value: {
              locator: { role: 'textbox', name: 'Lý do' },
              equals: 'something else',
            },
          },
        ],
      });
      const store = allowEnvVars(testStore(cfg), 'employee', [
        'FLOWCTL_TEST_SECRET',
      ]);
      const run = openRun(cfg, flow, { browser, store });
      await run.begin();
      for (const step of run.steps) await run.perform(step);
      const r = await run.finish(outcomeOf(await run.check(0)), 1);
      expect(r.status).toBe('failed');
      const saved = readFileSync(join(r.evidence.dir, 'run.json'), 'utf8');
      for (const text of [JSON.stringify(r), saved]) {
        expect(text).not.toContain('hunter2');
        expect(text).toContain('***');
      }
    } finally {
      delete process.env['FLOWCTL_TEST_SECRET'];
    }
  });

  it('refuses an env input the profile does not allow, before reading it (#41)', async () => {
    process.env['FLOWCTL_TEST_HOST_KEY'] = 'host-secret-value';
    try {
      const cfg = fixtureConfig(fixture.url);
      await seedProfiles(cfg, fixture.url);
      const flow = writeFlow(cfg, {
        ...FLOW,
        inputs: { note: { env: 'FLOWCTL_TEST_HOST_KEY' } },
      });
      const run = openRun(cfg, flow, {
        browser,
        store: testStore(cfg),
      });
      const err = await run.begin().catch((e: unknown) => e);
      expect(err).toMatchObject({ kind: 'env_not_allowed' });
      const r = await run.finish(toOutcome(err), 0);
      expect(r.status).toBe('error');
      expect(r.error?.hint).toContain(
        'flowctl trust add profile employee FLOWCTL_TEST_HOST_KEY',
      );
      expect(JSON.stringify(r)).not.toContain('host-secret-value');
    } finally {
      delete process.env['FLOWCTL_TEST_HOST_KEY'];
    }
  });

  it('still finishes with an error result when begin fails', async () => {
    const cfg = fixtureConfig(fixture.url);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    const outcome = await run
      .begin()
      .then(() => ({ status: 'passed' as const }), toOutcome);
    const r = await run.finish(outcome, 0);
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('profile_expired');
    expect(existsSync(join(r.evidence.dir, 'run.json'))).toBe(true);
  });
});

describe('RunSession session files (#46)', () => {
  it('refuses a storageState that is a symlink', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const state = storageStatePath(cfg, 'local', 'employee');
    const elsewhere = join(tmpdir(), `flowctl-state-${Date.now()}.json`);
    copyFileSync(state, elsewhere);
    rmSync(state);
    symlinkSync(elsewhere, state);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    await expect(run.begin()).rejects.toThrow(ConfigError);
    await run.finish(toOutcome(new Error('x')), 0);
  });

  it('still loads a session file saved before (mode 0644)', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    chmodSync(storageStatePath(cfg, 'local', 'employee'), 0o644);
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    await run.begin();
    expect(run.page.url()).toContain('/requests');
    await run.finish({ status: 'passed' }, 0);
  });
});

describe('RunSession loads only the env origin of a saved session (#50)', () => {
  it('drops a cookie for another site from an old session file before the first page opens', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const path = storageStatePath(cfg, 'local', 'employee');
    const state: { cookies: Record<string, unknown>[] } = JSON.parse(
      readFileSync(path, 'utf8'),
    );
    state.cookies.push({
      name: 'other',
      value: 'other-session',
      domain: 'prod.example.com',
      path: '/',
      expires: -1,
      httpOnly: true,
      secure: false,
      sameSite: 'Lax',
    });
    writeFileSync(path, JSON.stringify(state));
    const run = openRun(cfg, writeFlow(cfg, FLOW), { browser });
    await run.begin();
    const names = (
      await run.page
        .context()
        .cookies(['http://prod.example.com/', fixture.url])
    ).map((c) => c.name);
    expect(names).toContain('role');
    expect(names).not.toContain('other');
    await run.finish({ status: 'passed' }, 0);
  });
});
