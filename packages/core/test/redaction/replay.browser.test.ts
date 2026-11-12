import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/result.js';
import { outcomeOf, RunSession, type NetEntry } from '../../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from '../helpers.js';
import { allowEnvVars, testStore } from '../trust-fixture.js';
import { SECRET_ENV, echoFlow, withSecret } from './echo-flow.js';
import { freshSecret } from './find-secret.js';
import { decodePng, isConsoleEvent, leaksIn, runFiles } from './scan.js';

/**
 * A known secret never leaves a replay (T1.5, invariant 4, ADR 0030). A fresh secret with non-ASCII characters is
 * the flow's `env:` input; the replay types it into `/echo`, which echoes it in the page, the URL query, a request
 * body and a `\u`-escaped response body, and three assertions fail quoting it. Every file of the run directory (each
 * trace zip entry unpacked) and the returned result are scanned for every form `findSecret` knows.
 *
 * @remarks Scope today: the automated form login (T1.4) is not built, so no login form is typed; a secret reaches
 *   the page only as a flow input. The trace's console events keep the URL of a failed call, query included (ADR
 *   0030 "Not covered"): that one case is marked `it.fails`.
 */
let fixture: Fixture;
let browser: Browser;
const secret = freshSecret();
let result: RunResult;
let sent: NetEntry | undefined;
let shown: number | undefined;
let boxes: { x: number; y: number; width: number; height: number }[] = [];

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  const flow = writeFlow(cfg, echoFlow('redaction-replay'));
  const store = allowEnvVars(testStore(cfg), 'employee', [SECRET_ENV]);
  result = await withSecret(secret, async () => {
    const r = RunSession.open(cfg, flow, { browser, store });
    await r.begin();
    for (const step of r.steps) await r.perform(step);
    const verdict = await r.check(2000);
    for (const sel of ['#pw', '#note', '#old']) {
      const box = await r.page.locator(sel).boundingBox();
      if (box !== null) boxes.push(box);
    }
    sent = r.evidence.network.find((e) => e.method === 'POST');
    shown = await r.page.evaluate(() => {
      const t = document.getElementById('echo')?.textContent ?? '';
      const q = new URL(location.href).searchParams.get('q') ?? '';
      return t === `Đã nhận: ${q}` ? q.length : -1;
    });
    return r.finish(outcomeOf(verdict), 2);
  });
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

const files = (): Map<string, Buffer> => runFiles(result.evidence.dir);
const inTrace = (name: string): boolean => name.includes('.zip');
const traceLines = (): string[] =>
  [...files()]
    .filter(([name]) => name.endsWith(':trace.trace'))
    .flatMap(([, data]) => data.toString('utf8').split('\n'));
const otherTraceEntries = (): [string, Buffer][] =>
  [...files()].filter(
    ([name]) => inTrace(name) && !name.endsWith(':trace.trace'),
  );

describe('a replay with a secret input (T1.5)', () => {
  it('typed the secret and the app echoed it, so the scans below look at outputs that saw it', () => {
    expect(sent?.requestBody).toEqual({ ghiChu: secret, matKhau: secret });
    expect(sent?.url).toContain(encodeURIComponent(secret));
    expect(sent?.responseBody).toContain('"daNhan":"***"');
    expect(shown).toBe(secret.length);
    expect(result.status).toBe('failed');
    expect(result.evidence.trace).toBe('safe');
    expect(result.failed).toMatchObject({ got: '***' });
  });

  it('leaves no form of the secret in run.json, network.json, console.json, final.png or any other file', () => {
    const outside = [...files()].filter(([name]) => !inTrace(name));
    expect(outside.map(([name]) => name)).toEqual(
      expect.arrayContaining([
        'run.json',
        'network.json',
        'console.json',
        'final.png',
      ]),
    );
    expect(leaksIn(outside, secret)).toEqual([]);
    expect(
      readFileSync(join(result.evidence.dir, 'network.json'), 'utf8'),
    ).toContain('***');
  });

  it('leaves no form of the secret in the returned result', () => {
    expect(leaksIn([['result', JSON.stringify(result)]], secret)).toEqual([]);
  });

  it('leaves no form of the secret in the trace outside its console events: no element preview, no evaluated result', () => {
    const trace = traceLines().filter((l) => !isConsoleEvent(l));
    expect(trace.length).toBeGreaterThan(0);
    expect(
      leaksIn(
        trace.map((l, i) => [`trace line ${i}`, l]),
        secret,
      ),
    ).toEqual([]);
    expect(leaksIn(otherTraceEntries(), secret)).toEqual([]);
  });

  /**
   * Known leak: Playwright records every console message in the trace with its source location, and the browser's
   * "Failed to load resource" message for the 422 answer is located at the call's URL, whose query holds the secret
   * URL-encoded. `console.json` is redacted; the trace is not (ADR 0030 "Not covered").
   *
   * @see the T1.5 report, issue draft "A safe trace keeps a secret that the app puts in a URL"
   */
  it.fails('leaves no form of the secret in the console events of the trace', () => {
    const lines = traceLines().filter(isConsoleEvent);
    expect(
      leaksIn(
        lines.map((l, i) => [`console line ${i}`, l]),
        secret,
      ),
    ).toEqual([]);
  });

  it('paints the mask over the password fields and the field holding the secret in final.png', () => {
    const png = decodePng(readFileSync(join(result.evidence.dir, 'final.png')));
    expect(boxes).toHaveLength(3);
    for (const b of boxes) {
      const [r, g, bl] = png.rgb(b.x + b.width / 2, b.y + b.height / 2);
      expect({ r, g, b: bl }).toEqual({ r: 255, g: 0, b: 255 });
    }
  });
});
