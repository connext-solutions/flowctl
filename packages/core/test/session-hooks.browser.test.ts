import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FlowError } from '../src/flow/index.js';
import { RunError, RunSession, toOutcome } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';
import { allowEnvVars, consentHooks, testStore } from './trust-fixture.js';

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

/** A config, its saved sessions, a flow written to its flows directory, and a store consenting to it. */
async function project(
  doc: Record<string, unknown> & { name: string },
  consent = true,
) {
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  mkdirSync(cfg.flowsPath, { recursive: true });
  const flow = writeFlow(cfg, doc);
  let store = testStore(cfg);
  if (consent) store = consentHooks(cfg, store, [flow]);
  return { cfg, flow, store };
}

describe('RunSession hook consent (ADR 0021, ADR 0025 section 5)', () => {
  it('refuses hooks with no consent before running them', async () => {
    const { cfg, flow, store } = await project(
      { ...FLOW, name: 'hooked-flow', setup: 'true' },
      false,
    );
    const run = RunSession.open(cfg, flow, { browser, store });
    const err = await run.begin().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RunError);
    expect(err instanceof RunError ? err.kind : '').toBe('hooks_untrusted');
    expect(err instanceof RunError ? err.hint : '').toContain('no_entry');
    expect(err instanceof RunError ? err.hint : '').toContain(
      'flowctl trust hook hooked-flow',
    );
    await run.finish(toOutcome(err), 0);
  });

  it('refuses a hook edited after consent', async () => {
    const { cfg, flow, store } = await project({
      ...FLOW,
      name: 'edited',
      setup: 'true',
    });
    const edited = writeFlow(cfg, { ...FLOW, name: 'edited', setup: 'true ' });
    const run = RunSession.open(cfg, edited, { browser, store });
    const err = await run.begin().catch((e: unknown) => e);
    expect(err instanceof RunError ? err.hint : '').toContain(
      'digest_mismatch',
    );
    await run.finish(toOutcome(err), 0);
    expect(flow.name).toBe('edited');
  });

  it('runs consented hooks from a snapshot, setup and teardown sharing it', async () => {
    const { cfg, flow, store } = await project({
      ...FLOW,
      name: 'snap',
      setup: 'touch ./.hook-tmp/a',
      teardown: '[ -f ./.hook-tmp/a ]',
    });
    const run = RunSession.open(cfg, flow, { browser, store });
    await run.begin();
    const r = await run.finish({ status: 'passed' }, 0);
    expect(r.teardownFailed).toBe(false);
  });

  it('runs a consented closure script and refuses it once the script changes', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    mkdirSync(cfg.flowsPath, { recursive: true });
    writeFileSync(join(cfg.flowsPath, 'seed.sh'), '#!/bin/sh\ntrue\n', {
      mode: 0o755,
    });
    const flow = writeFlow(cfg, {
      ...FLOW,
      name: 'scripted',
      setup: './seed.sh',
    });
    const store = consentHooks(cfg, testStore(cfg), [flow]);
    const ok = RunSession.open(cfg, flow, { browser, store });
    await ok.begin();
    await ok.finish({ status: 'passed' }, 0);
    writeFileSync(join(cfg.flowsPath, 'seed.sh'), '#!/bin/sh\nfalse\n', {
      mode: 0o755,
    });
    const bad = RunSession.open(cfg, flow, { browser, store });
    const err = await bad.begin().catch((e: unknown) => e);
    expect(err instanceof RunError ? err.hint : '').toContain(
      'digest_mismatch',
    );
    await bad.finish(toOutcome(err), 0);
  });

  it('gives a hook only the built environment, never a secret of the parent', async () => {
    process.env.FLOWCTL_TEST_SECRET = 's3cr3t';
    try {
      const { cfg, flow, store } = await project({
        ...FLOW,
        name: 'env-probe',
        setup: '[ -z "$FLOWCTL_TEST_SECRET" ] && [ "$HOME" != "/" ]',
      });
      const run = RunSession.open(cfg, flow, { browser, store });
      await run.begin();
      await run.finish({ status: 'passed' }, 0);
    } finally {
      delete process.env.FLOWCTL_TEST_SECRET;
    }
  });

  it('reports a teardown refused at run time as hooks_untrusted, not internal', async () => {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    mkdirSync(cfg.flowsPath, { recursive: true });
    const flow = writeFlow(cfg, {
      ...FLOW,
      name: 'td-refused',
      setup: 'true',
      teardown: 'true',
    });
    const store = consentHooks(cfg, testStore(cfg), [flow], {
      env: ['PGHOST'],
      pins: { PGHOST: 'db.local' },
    });
    const saved = process.env.PGHOST;
    process.env.PGHOST = 'db.local';
    try {
      const run = RunSession.open(cfg, flow, { browser, store });
      await run.begin();
      process.env.PGHOST = 'attacker.example';
      const r = await run.finish({ status: 'passed' }, 0);
      expect(r.status).toBe('error');
      expect(r.error?.kind).toBe('hooks_untrusted');
      expect(r.error?.hint).toContain('env_value_mismatch');
      expect(r.error?.hint).not.toContain('attacker.example');
      expect(r.teardownFailed).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PGHOST;
      else process.env.PGHOST = saved;
    }
  });
});

describe('RunSession lifecycle (#22, #23)', () => {
  it('skips teardown when the run never started (unset env input)', async () => {
    const { cfg, flow, store } = await project({
      ...FLOW,
      name: 'lc-unset',
      inputs: { x: { env: 'FLOWCTL_UNSET_X' } },
      teardown: 'false',
    });
    const allowed = allowEnvVars(store, 'employee', ['FLOWCTL_UNSET_X']);
    const run = RunSession.open(cfg, flow, { browser, store: allowed });
    const err = await run.begin().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlowError);
    const r = await run.finish(toOutcome(err), 0);
    expect(r.status).toBe('error');
    expect(r.teardownFailed).toBe(false);
  });

  it('runs teardown after a setup that started and failed', async () => {
    const { cfg, flow, store } = await project({
      ...FLOW,
      name: 'lc-setup-failed',
      setup: 'exit 1',
      teardown: 'false',
    });
    const run = RunSession.open(cfg, flow, { browser, store });
    const err = await run.begin().catch((e: unknown) => e);
    const r = await run.finish(toOutcome(err), 0);
    expect(r.error?.kind).toBe('setup_failed');
    expect(r.teardownFailed).toBe(true);
  });

  it('returns an error result instead of throwing when evidence cannot be collected', async () => {
    const { cfg, flow, store } = await project({
      ...FLOW,
      name: 'lc-crash',
      teardown: 'true',
    });
    const run = RunSession.open(cfg, flow, { browser, store });
    await run.begin();
    await run.page.context().close();
    const r = await run.finish({ status: 'passed' }, 0);
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('internal');
    expect(r.error?.hint).toContain('finish');
    expect(browser.contexts()).toHaveLength(0);
    expect(r.teardownFailed).toBe(false);
  });
});
