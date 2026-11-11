import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { replayFlow } from '../src/replay.js';
import { RunLedger } from '../src/run/ledger/index.js';
import { LEDGER_IO } from '../src/trust/ledger-file.js';
import { writeFlow } from './helpers.js';
import {
  CREATE_STEPS,
  crud,
  LedgerApp,
  ledgerLines,
} from './ledger-fixture.js';

/**
 * A confirmed replay on a `shared` env when something around the ledger goes wrong (ADR 0024 section 5 and the
 * amendment 2026-11-13 "as implemented"): a ledger write that fails, and a create answered after the wait for
 * writes in flight while cleanup runs.
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

describe('ledger failures in a confirmed replay', () => {
  it('ends the run error internal, never failed, when the intent line cannot be written', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-enospc', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const real = LEDGER_IO.write;
    LEDGER_IO.write = (fd, buf, off, len) => {
      if (buf.includes('"kind":"intent"'))
        throw Object.assign(new Error('ENOSPC: no space left on device'), {
          code: 'ENOSPC',
        });
      return real(fd, buf, off, len);
    };
    let r;
    try {
      r = await replayFlow(cfg, flow, { browser, store });
    } finally {
      LEDGER_IO.write = real;
    }
    expect(r.status, JSON.stringify(r.failed)).toBe('error');
    expect(r.error?.kind).toBe('internal');
    expect(r.error?.hint).toContain('ENOSPC');
    expect(await app.items()).toEqual([]);
    expect(ledgerLines(store, r.runId)).toEqual(['ledger-header']);
  });

  it('never records a create answered after the wait for writes in flight, even while cleanup runs', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, {
      ...crud('items-after-wait', [
        ...CREATE_STEPS.slice(0, 2),
        { wait: 1500 },
        { fill: { role: 'textbox', name: 'Tên mục' }, input: 'ten2' },
        { click: { role: 'button', name: 'Tạo' } },
      ]),
      inputs: {
        ten: { value: 'QA-{{uid}}' },
        ten2: { value: 'QA-{{uid}}-b' },
      },
      assertions: [{ text: 'Mục' }],
    });
    const store = app.confirm(cfg, empty, flow);
    const wait = RunLedger.waitMs;
    RunLedger.waitMs = 200;
    try {
      const run = replayFlow(cfg, flow, { browser, store });
      await expect.poll(() => app.items(), { timeout: 5000 }).toHaveLength(1);
      await app.next({ delayMs: 2000 });
      await app.next({ deleteDelayMs: 4000 });
      const r = await run;
      expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
      expect(ledgerLines(store, r.runId)).toEqual([
        'ledger-header',
        'intent',
        'id',
        'intent',
        'cleanup:confirmed',
      ]);
      expect(r.cleanup).toEqual({
        confirmed: 1,
        leftover: [
          {
            entry: `${flow.name}-create`,
            id: null,
            name: expect.stringMatching(/^QA-.+-b$/),
            detail: 'create_unconfirmed',
          },
        ],
      });
    } finally {
      RunLedger.waitMs = wait;
    }
  });
});
