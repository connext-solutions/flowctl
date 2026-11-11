import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replayFlow } from '../src/replay.js';
import { RunLedger } from '../src/run/index.js';
import { LedgerFile } from '../src/trust/index.js';
import { CREATE, store as testStore } from './confirm-fixture.js';
import { writeFlow } from './helpers.js';
import {
  CREATE_STEPS,
  crud,
  LedgerApp,
  ledgerLines,
} from './ledger-fixture.js';

/**
 * The end of a confirmed replay on a `shared` env (ADR 0024 section 5, ledger rules 9 and 10): a create still in
 * flight when the run ends is waited for, recorded and removed; a ledger problem it brings ends the run `error`;
 * and only an env the store classes `shared` gets a ledger.
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

/** The create steps without the wait, and an assertion that holds before the create answers. */
const late = (name: string, start?: string) => ({
  ...crud(name, CREATE_STEPS.slice(0, 2), start),
  assertions: [{ text: 'Mục' }],
});

describe('the end of a confirmed replay', () => {
  it('waits for a create still in flight, records its id and removes it', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, late('items-late'));
    const store = app.confirm(cfg, empty, flow);
    await app.next({ delayMs: 2500 });
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

  it('ends the run error when a create answered during the end is a ledger problem', async () => {
    const { cfg, store: empty } = await app.setup();
    const id = 'd1b2c3d4-0000-4000-8000-00000000abcd';
    const flow = writeFlow(
      cfg,
      late('items-late-replay', `/items?ref=${id.toUpperCase()}`),
    );
    const store = app.confirm(cfg, empty, flow);
    await app.next({ id, delayMs: 2500 });
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.status).toBe('error');
    expect(r.error?.kind).toBe('ledger_replay');
    expect(ledgerLines(store, r.runId).at(-1)).toBe('abort');
  });

  it('keeps no ledger for an env the store classes local, even on the origin of a shared one', async () => {
    const { cfg, store: empty } = await app.setup(true);
    const flow = writeFlow(cfg, crud('items-twin', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow, { env: 'dev' });
    const r = await replayFlow(cfg, flow, { browser, store, env: 'dev' });
    expect(r.error?.kind, JSON.stringify(r)).toBe('destructive_blocked');
    expect(r.cleanup).toBeUndefined();
    expect(await app.items()).toEqual([]);
  });
});

describe('a write whose headers are read while the run ends', () => {
  it('is refused as the run was ending, before it is matched or sent', async () => {
    const refused: string[] = [];
    const ledger = new RunLedger({
      entries: [CREATE],
      file: LedgerFile.create(testStore().dir, 'r_late01', null),
      uid: () => 'ab12cd34',
      refuse: (_m, _u, why) => refused.push(why),
    });
    const context = await browser.newContext();
    try {
      let finished: Promise<unknown> = Promise.resolve();
      await context.route('**/api/items', (route) => {
        const judged = ledger.authorise(route, () => context.pages());
        finished = ledger.finish(() => Promise.resolve(404));
        return judged;
      });
      const page = await context.newPage();
      await page.goto(`${fixture.url}/items`);
      const sent = await page.evaluate(() =>
        fetch('/api/items', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'QA-ab12cd34' }),
        }).then(
          () => 'answered',
          () => 'aborted',
        ),
      );
      await finished;
      expect(sent).toBe('aborted');
      expect(refused).toEqual(['the run was ending']);
      expect(await app.items()).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
