import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/result.js';
import { replayFlow } from '../../src/replay.js';
import { writeFlow } from '../helpers.js';
import { CREATE_STEPS, crud, LedgerApp } from '../ledger-fixture.js';
import { freshSecret } from './find-secret.js';
import { leaksIn, runOutputs } from './scan.js';

/**
 * The run ledger reads the text of every page before a confirmed create (ledger rule 2), and that read stays out of
 * a safe trace (T1.5, ADR 0030 amendment 2026-11-12): an item named with a fresh secret is listed on `/items` before
 * the run starts, so the page text the ledger scans holds it, and the replay's run directory, its trace included, is
 * scanned for every form of it.
 *
 * @remarks The secret here is page text, not a flow input, so nothing masks it in `run.json` or `network.json`: only
 *   the trace entries are scanned. On `/items` it is the name of a "Xoá" button that no step targets, so no locator
 *   of the flow names it.
 */
let fixture: Fixture;
let browser: Browser;
const secret = freshSecret();
let result: RunResult;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  const app = new LedgerApp(fixture.url);
  await app.seed(`Ghi chú ${secret}`);
  const { cfg, store: empty } = await app.setup();
  const flow = writeFlow(cfg, crud('redaction-ledger', CREATE_STEPS));
  const store = app.confirm(cfg, empty, flow);
  result = await replayFlow(cfg, flow, { browser, store });
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

describe('a confirmed replay that scans the page text for its ledger (T1.5)', () => {
  it('created, recorded and cleaned up its record on a page that showed the secret', () => {
    expect(result.status, JSON.stringify(result.error ?? result.failed)).toBe(
      'passed',
    );
    expect(result.cleanup).toEqual({ confirmed: 1, leftover: [] });
    expect(result.evidence.trace).toBe('safe');
  });

  it('leaves no form of the page text secret in the trace', () => {
    const trace = runOutputs(result.evidence.dir).filter(([name]) =>
      name.includes('.zip:'),
    );
    expect(trace.length).toBeGreaterThan(0);
    expect(leaksIn(trace, secret)).toEqual([]);
  });
});
