import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replayFlow } from '../src/replay.js';
import { writeFlow } from './helpers.js';
import {
  CREATE_STEPS,
  crud,
  DELETE_STEP,
  LedgerApp,
  ledgerLines,
} from './ledger-fixture.js';

/**
 * Replay on a `shared` env with stored confirmations (ADR 0024 section 5, "The run ledger", and its amendment
 * 2026-11-12): a confirmed flow writes, records the ids it created and cleans them up; anything an entry does not
 * authorise is still refused; a created id seen earlier aborts the run.
 */
let fixture: Fixture;
let browser: Browser;
let app: LedgerApp;
beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  app = new LedgerApp(fixture.url);
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
beforeEach(async () => {
  await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
});

describe('replay on a shared env with stored confirmations', () => {
  it('creates and deletes its own record, records the id, and confirms the cleanup', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(
      cfg,
      crud('items-crud', [...CREATE_STEPS, DELETE_STEP, { wait: 200 }]),
    );
    const store = app.confirm(cfg, empty, flow);
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
    expect(r.cleanup).toEqual({ confirmed: 1, leftover: [] });
    expect(await app.items()).toEqual([]);
    expect(ledgerLines(store, r.runId)).toEqual([
      'ledger-header',
      'intent',
      'id',
      'cleanup:confirmed',
    ]);
  });

  it('removes at the end a record the flow created and left', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-keep', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
    expect(r.cleanup).toEqual({ confirmed: 1, leftover: [] });
    expect(await app.items()).toEqual([]);
  });

  it('still refuses a write no entry authorises, and a flow changed after it was confirmed', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-new', CREATE_STEPS));
    const blocked = await replayFlow(cfg, flow, { browser, store: empty });
    expect(blocked.error?.kind).toBe('destructive_blocked');
    expect(blocked.error?.hint).toContain(
      'flowctl trust add destructive items-new',
    );
    const store = app.confirm(cfg, empty, flow);
    const edited = writeFlow(cfg, {
      ...crud('items-new', CREATE_STEPS),
      goal: 'Đã sửa',
    });
    const stale = await replayFlow(cfg, edited, { browser, store });
    expect(stale.error?.kind).toBe('destructive_blocked');
    expect(stale.error?.hint).toContain('another version');
    expect(await app.items()).toEqual([]);
  });

  it('refuses to delete a record the run did not create', async () => {
    const { cfg, store: empty } = await app.setup();
    await app.seed('QA-seeded');
    const flow = writeFlow(
      cfg,
      crud('items-foreign', [
        { click: { role: 'button', name: 'Xoá QA-seeded' } },
        { wait: 200 },
      ]),
    );
    const store = app.confirm(cfg, empty, flow);
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.error?.kind, JSON.stringify(r)).toBe('destructive_blocked');
    expect(r.error?.hint).toContain('not one of them');
    expect(await app.items()).toEqual(['QA-seeded']);
  });

  it('aborts with ledger_replay when the created id appeared earlier in the run, and writes the abort line last', async () => {
    const { cfg, store: empty } = await app.setup();
    const id = 'a1b2c3d4-0000-4000-8000-00000000abcd';
    await app.nextId(id);
    const flow = writeFlow(
      cfg,
      crud('items-replay', CREATE_STEPS, `/items?ref=${id.toUpperCase()}`),
    );
    const store = app.confirm(cfg, empty, flow);
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('ledger_replay');
    expect(r.error?.hint).toContain('items-replay-create');
    expect(r.error?.hint).toContain('request 1');
    expect(ledgerLines(store, r.runId).at(-1)).toBe('abort');
  });
});
