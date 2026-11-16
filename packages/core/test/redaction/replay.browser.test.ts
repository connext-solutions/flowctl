import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../../src/result.js';
import {
  DRAFT_PROVENANCE,
  outcomeOf,
  RunSession,
  type NetEntry,
} from '../../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from '../helpers.js';
import { allowEnvVars, testStore } from '../trust-fixture.js';
import { CHECK, SECRET_ENV, echoFlow, withSecret } from './echo-flow.js';
import { freshSecret } from './find-secret.js';
import {
  consoleUrls,
  decodePng,
  leaksIn,
  runFiles,
  scrubTraceLine,
  type Png,
} from './scan.js';

/**
 * A known secret never leaves a replay (T1.5, invariant 4, ADR 0030). A fresh secret with non-ASCII characters is
 * the flow's `env:` input; the replay types it into `/echo`, which echoes it in the page, the URL query, a request
 * body and a `\u`-escaped response body, and three assertions fail quoting it. Every file of the run directory (each
 * trace zip entry unpacked) and the returned result are scanned for every form `findSecret` knows.
 *
 * @remarks Scope today: the automated form login (T1.4) is not built, so no login form is typed; a secret reaches
 *   the page only as a flow input. Two known leaks are marked `it.fails` (ADR 0030 "Not covered"): the trace's
 *   console events keep the URL of a failed call, query included, and `final.png` shows the secret the page renders
 *   as text.
 */
let fixture: Fixture;
let browser: Browser;
const secret = freshSecret();
let result: RunResult;
let sent: NetEntry | undefined;
let shown: number | undefined;
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
const boxes: Box[] = [];
let echoBox: Box | null = null;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  const flow = writeFlow(cfg, echoFlow('redaction-replay'));
  const store = allowEnvVars(testStore(cfg), 'employee', [SECRET_ENV]);
  result = await withSecret(secret, async () => {
    const r = RunSession.open(cfg, flow, {
      provenance: DRAFT_PROVENANCE,
      browser,
      store,
    });
    await r.begin();
    for (const step of r.steps) await r.perform(step);
    const verdict = await r.check(2000);
    for (const sel of ['#pw', '#note', '#old']) {
      const box = await r.page.locator(sel).boundingBox();
      if (box !== null) boxes.push(box);
    }
    echoBox = await r.page.evaluate(() => {
      const e = document.getElementById('echo')?.getBoundingClientRect();
      return e === undefined
        ? null
        : { x: e.x, y: e.y, width: e.width, height: e.height };
    });
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
const traceText = (): string =>
  [...files()]
    .filter(([name]) => name.endsWith(':trace.trace'))
    .map(([, data]) => data.toString('utf8'))
    .join('\n');
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

  it('unpacked the trace: a recorded action names the button the flow clicks', () => {
    const before = traceText()
      .split('\n')
      .flatMap((l): unknown[] => {
        try {
          return [JSON.parse(l)];
        } catch {
          return [];
        }
      })
      .filter(
        (v) =>
          typeof v === 'object' &&
          v !== null &&
          'type' in v &&
          v.type === 'before' &&
          'params' in v &&
          typeof v.params === 'object' &&
          v.params !== null &&
          'selector' in v.params &&
          String(v.params.selector).includes(CHECK.name),
      );
    expect(before.length).toBeGreaterThan(0);
  });

  it('leaves no form of the secret in the trace but a console source URL: no element preview, no evaluated result', () => {
    const trace = traceText().split('\n').map(scrubTraceLine);
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
  it.fails('leaves no form of the secret in the source URLs of the trace console events', () => {
    const urls = consoleUrls(traceText());
    expect(urls.length).toBeGreaterThan(0);
    expect(
      leaksIn(
        urls.map((u, i) => [`console source URL ${i}`, u]),
        secret,
      ),
    ).toEqual([]);
  });

  it('paints the mask colour on every pixel of the password fields and the field holding the secret in final.png', () => {
    const png = decodePng(readFileSync(join(result.evidence.dir, 'final.png')));
    expect(boxes).toHaveLength(3);
    for (const b of boxes) expect(unmasked(png, b)).toEqual([]);
  });

  /**
   * Known gap: `final.png` masks fields only, so the secret the page shows as text ("Đã nhận: …" in `#echo`) is in
   * the picture (ADR 0030 "Not covered", "Elsewhere": a secret the app renders as text outside a field). The box is
   * read with `page.evaluate`, which returns only numbers: `locator.boundingBox` would log a preview of the element,
   * secret included, into the trace the scans above read.
   */
  it.fails('masks the secret the page renders as text', () => {
    const png = decodePng(readFileSync(join(result.evidence.dir, 'final.png')));
    expect(echoBox).not.toBeNull();
    if (echoBox !== null) expect(unmasked(png, echoBox)).toEqual([]);
  });
});

/** The mask colour flowctl paints over fields in `final.png`. */
const MASK = [255, 0, 255].join();

/** Up to 10 pixels of `b`, inset by 2 px against anti-aliased edges, whose colour is not the mask colour. */
function unmasked(png: Png, b: Box): string[] {
  const out: string[] = [];
  for (let y = Math.ceil(b.y + 2); y < Math.floor(b.y + b.height - 2); y++)
    for (let x = Math.ceil(b.x + 2); x < Math.floor(b.x + b.width - 2); x++)
      if (png.rgb(x, y).join() !== MASK && out.length < 10)
        out.push(`${x},${y}`);
  return out;
}
