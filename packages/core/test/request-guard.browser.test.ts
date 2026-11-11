import { createServer, type Server } from 'node:http';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RequestGuard, RunSession } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';

/**
 * The request layer on redirect hops (ADR 0024 section 5, T1.3 chunk 1): `hopper` and `sink` are origins in scope;
 * `hopper` answers every path with a redirect to `sink`'s `/items/purge`, a side-effecting GET that `sink` counts.
 * The hop's method and type are judged, so on a shared env the purge is never sent, whether the hop comes from a
 * fetch, a POST answered 303, a page or a popup's first navigation.
 */
let fixture: Fixture;
let browser: Browser;
let hopper: Server;
let sink: Server;
let hopperUrl = '';
let sinkUrl = '';
let purges = 0;

const listen = (s: Server): Promise<string> =>
  new Promise((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`);
    }),
  );

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  sink = createServer((req, res) => {
    if (req.url?.startsWith('/items/purge') === true) purges++;
    res.writeHead(200, {
      'content-type': 'text/html',
      'access-control-allow-origin': '*',
    });
    res.end('<p>sink</p>');
  });
  sinkUrl = await listen(sink);
  hopper = createServer((req, res) => {
    res.writeHead(req.url?.startsWith('/post') === true ? 303 : 302, {
      location: `${sinkUrl}/items/purge`,
      'access-control-allow-origin': '*',
    });
    res.end();
  });
  hopperUrl = await listen(hopper);
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => hopper.close(r));
  await new Promise((r) => sink.close(r));
  await fixture.close();
});
beforeEach(() => {
  purges = 0;
});

const FLOW = {
  name: 'writes-flow',
  goal: 'g',
  profile: 'employee',
  start: '/map',
  steps: [{ wait: 10 }],
  assertions: [{ text: 'Sơ đồ' }],
};

async function open(envClass: 'shared' | 'local'): Promise<RunSession> {
  const cfg = fixtureConfig(fixture.url);
  const sets = [fixture.url, hopperUrl, sinkUrl];
  cfg.trustView = {
    refused: {},
    scopes: { local: { visit: sets, call: sets } },
  };
  await seedProfiles(cfg, fixture.url);
  const run = RunSession.open(cfg, writeFlow(cfg, FLOW), {
    browser,
    writes: new RequestGuard(envClass, false),
  });
  await run.begin();
  return run;
}

const kindOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error && 'kind' in e ? String(e.kind) : String(e);
  }
  return undefined;
};

const HOPS = [
  ['a fetch', (h: string) => `fetch('${h}/get').catch(() => {})`],
  [
    'a POST answered 303',
    (h: string) => `fetch('${h}/post', { method: 'POST' }).catch(() => {})`,
  ],
  ['a page navigation', (h: string) => `location.href = '${h}/page'`],
  ['a popup', (h: string) => `window.open('${h}/popup')`],
] as const;

describe('the request layer on redirect hops', () => {
  it.each(HOPS)(
    'stops %s whose hop is a destructive GET, on a shared env',
    async (_what, script) => {
      const run = await open('shared');
      await run.page.evaluate(script(hopperUrl)).catch(() => undefined);
      await expect.poll(() => kindOf(run.check(0))).toBe('destructive_blocked');
      const result = await run.finish({ status: 'passed' }, 0);
      expect(result.error?.kind).toBe('destructive_blocked');
      expect(purges).toBe(0);
    },
  );

  it.each(HOPS)(
    'follows the hop of %s on a local env',
    async (_what, script) => {
      const run = await open('local');
      await run.page.evaluate(script(hopperUrl)).catch(() => undefined);
      await expect.poll(() => purges).toBe(1);
      expect((await run.finish({ status: 'passed' }, 0)).error).toBeUndefined();
    },
  );
});
