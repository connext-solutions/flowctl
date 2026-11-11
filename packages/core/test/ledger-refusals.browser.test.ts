import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { replayFlow } from '../src/replay.js';
import type { RunResult } from '../src/result.js';
import { RunSession } from '../src/run/index.js';
import { LedgerFile } from '../src/trust/index.js';
import { writeFlow } from './helpers.js';
import {
  CREATE_STEPS,
  crud,
  LedgerApp,
  ledgerLines,
} from './ledger-fixture.js';

/**
 * What a confirmed replay on a `shared` env refuses or reports (ADR 0024 section 5 and its amendment 2026-11-12,
 * "Tests this implies"): names without the uid or the prefix, a redirect or a non-canonical id from a create, an id
 * seen only in the page text, a 409, a `session` entry, and a ledger file that exists already.
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

/** Replays a confirmed copy of `doc` on the shared env. */
async function confirmedRun(
  doc: ReturnType<typeof crud>,
): Promise<{ r: RunResult; lines: () => string[] }> {
  const { cfg, store: empty } = await app.setup();
  const flow = writeFlow(cfg, doc);
  const store = app.confirm(cfg, empty, flow);
  const r = await replayFlow(cfg, flow, { browser, store });
  return { r, lines: () => ledgerLines(store, r.runId) };
}

describe('a confirmed replay refuses', () => {
  it('a create whose name lacks the run uid or the QA- prefix', async () => {
    for (const [name, value] of [
      ['items-nouid', 'QA-fixed'],
      ['items-noprefix', 'X-{{uid}}'],
    ] as const) {
      const { r } = await confirmedRun({
        ...crud(name, CREATE_STEPS),
        inputs: { ten: { value } },
      });
      expect(r.error?.kind, name).toBe('destructive_blocked');
      expect(r.error?.hint).toContain("holds the run's {{uid}}");
    }
    expect(await app.items()).toEqual([]);
  });

  it('a create answered with a redirect: ledger_mismatch, the intent unconfirmed', async () => {
    await app.next({ status: 302 });
    const { r, lines } = await confirmedRun(crud('items-302', CREATE_STEPS));
    expect(r.error?.kind).toBe('ledger_mismatch');
    expect(r.error?.hint).toContain('a redirect');
    expect(r.cleanup?.leftover.map((l) => l.detail)).toEqual([
      'create_unconfirmed',
    ]);
    expect(lines().at(-1)).toBe('abort');
  });

  it('a create returning "0007": ledger_mismatch', async () => {
    await app.nextId('0007');
    const { r } = await confirmedRun(crud('items-0007', CREATE_STEPS));
    expect(r.error?.kind).toBe('ledger_mismatch');
  });

  it('a create returning a number seen only in the page text: ledger_replay', async () => {
    const n = '987654321012';
    await app.nextId(n);
    const { r } = await confirmedRun(
      crud('items-total', CREATE_STEPS, `/items#total=${n}`),
    );
    expect(r.error?.kind, JSON.stringify(r)).toBe('ledger_replay');
    expect(r.error?.hint).toContain(n);
  });

  it('a create returning a number seen only in the text of another context of the run: ledger_replay', async () => {
    const n = '876543210987';
    await app.nextId(n);
    const { r } = await confirmedRun(
      crud('items-other-page', [
        { as: 'manager', goto: `/items#total=${n}` },
        { wait: 200 },
        { as: 'employee' },
        ...CREATE_STEPS,
      ]),
    );
    expect(r.error?.kind, JSON.stringify(r)).toBe('ledger_replay');
    expect(r.error?.hint).toContain(n);
  });

  it("a create returning an id seen only in the body of a popup's first document: ledger_replay", async () => {
    const id = 'e1b2c3d4-0000-4000-8000-00000000abcd';
    await app.nextId(id);
    const { r } = await confirmedRun(
      crud('items-popup', [
        { click: { role: 'link', name: 'Báo cáo' } },
        { wait: 300 },
        ...CREATE_STEPS,
      ]),
    );
    expect(r.error?.kind, JSON.stringify(r)).toBe('ledger_replay');
    expect(r.error?.hint).toContain(id);
  });
});

describe('a confirmed replay records', () => {
  it('a 409 as a none line, not as unconfirmed', async () => {
    const { r, lines } = await confirmedRun(
      crud('items-409', [...CREATE_STEPS, ...CREATE_STEPS]),
    );
    expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
    expect(r.cleanup).toEqual({ confirmed: 1, leftover: [] });
    expect(lines()).toEqual([
      'ledger-header',
      'intent',
      'id',
      'intent',
      'none',
      'cleanup:confirmed',
    ]);
  });

  it('nothing for a write a session entry authorises, which it sends as is', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-session', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow, {
      only: (base) => [
        {
          ...base,
          id: 'items-session-login',
          kind: 'session',
          method: 'POST',
          template: '/api/items',
          contentType: 'json',
          bodyKeys: ['/name'],
        },
      ],
    });
    const r = await replayFlow(cfg, flow, { browser, store });
    expect(r.status, JSON.stringify(r.error ?? r.failed)).toBe('passed');
    expect(r.cleanup).toEqual({ confirmed: 0, leftover: [] });
    expect(ledgerLines(store, r.runId)).toEqual(['ledger-header']);
    expect(await app.items()).toHaveLength(1);
  });

  it('ledger_exists before its first request when its ledger file exists', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-exists', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const open = RunSession.open.bind(RunSession);
    const spy = vi.spyOn(RunSession, 'open').mockImplementation((c, f, o) => {
      const run = open(c, f, o);
      LedgerFile.create(store.dir, run.runId, null).close();
      return run;
    });
    let r: RunResult;
    try {
      r = await replayFlow(cfg, flow, { browser, store });
    } finally {
      spy.mockRestore();
    }
    expect(r.error?.kind).toBe('ledger_exists');
    expect(r.steps).toBe(0);
    expect(await app.items()).toEqual([]);
  });
});
