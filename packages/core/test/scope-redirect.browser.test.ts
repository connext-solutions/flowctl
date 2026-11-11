import { createServer, type Server } from 'node:http';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunSession } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';

/**
 * Redirect hops under the scope guard (ADR 0024 section 3, "at every redirect hop", T1.2): `hopper` is an origin in
 * the run's scope whose every path answers 302 to `outside`, which is not. A hop out of scope must be stopped
 * before the browser follows it, so `outside` never sees a request.
 */
let fixture: Fixture;
let browser: Browser;
let hopper: Server;
let outside: Server;
let hopperUrl = '';
let outsideUrl = '';
let outsideHits: string[] = [];

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
  outside = createServer((req, res) => {
    outsideHits.push(req.url ?? '');
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('outside');
  });
  outsideUrl = await listen(outside);
  hopper = createServer((req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/drop')) {
      req.socket.destroy();
      return;
    }
    if (url.startsWith('/slow')) {
      res.writeHead(200, { 'access-control-allow-origin': '*' });
      res.write('x');
      setTimeout(() => res.end('y'), 500);
      return;
    }
    const to = url.startsWith('/in')
      ? `${fixture.url}/map`
      : url.startsWith('/twice')
        ? `${hopperUrl}/out`
        : `${outsideUrl}${url}`;
    res.writeHead(302, { location: to, 'access-control-allow-origin': '*' });
    res.end();
  });
  hopperUrl = await listen(hopper);
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => hopper.close(r));
  await new Promise((r) => outside.close(r));
  await fixture.close();
});
beforeEach(() => {
  outsideHits = [];
});

const FLOW = {
  name: 'redirect-flow',
  goal: 'g',
  profile: 'employee',
  start: '/map',
  steps: [{ wait: 10 }],
  assertions: [{ text: 'Sơ đồ' }],
};

async function open(): Promise<RunSession> {
  const cfg = fixtureConfig(fixture.url);
  const sets = [fixture.url, hopperUrl];
  cfg.trustView = {
    refused: {},
    scopes: { local: { visit: sets, call: sets } },
  };
  await seedProfiles(cfg, fixture.url);
  const run = RunSession.open(cfg, writeFlow(cfg, FLOW), { browser });
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

/**
 * Resolves when a request to `hopper` fails in the run's context: the guard failed its redirect answer, so the browser
 * never sent the hop. Without the hold the hop is followed, the request does not fail, and this times out.
 */
const hopFailed = (run: RunSession): Promise<unknown> =>
  run.page.context().waitForEvent('requestfailed', {
    predicate: (r) => r.url().startsWith(hopperUrl),
    timeout: 5000,
  });

describe('redirect hops under the scope guard', () => {
  it.each([
    ['a page navigation', (h: string) => `location.href = '${h}/page'`],
    ['a fetch', (h: string) => `fetch('${h}/api').catch(() => {})`],
    ['an image', (h: string) => `new Image().src = '${h}/pixel.png'`],
    [
      'an iframe',
      (h: string) =>
        `document.body.append(Object.assign(document.createElement('iframe'), { src: '${h}/frame' }))`,
    ],
  ])(
    'stops %s whose redirect leaves the scope before the hop is sent',
    async (_what, script) => {
      const run = await open();
      const stopped = hopFailed(run);
      await run.page.evaluate(script(hopperUrl)).catch(() => undefined);
      await stopped;
      expect(await kindOf(run.check(0))).toBe('scope_violation');
      await run.finish({ status: 'passed' }, 0);
      expect(outsideHits).toEqual([]);
    },
  );

  it('stops the first hop of a popup opened by the page', async () => {
    const run = await open();
    const stopped = hopFailed(run);
    await run.page.evaluate(`window.open('${hopperUrl}/popup')`);
    await stopped;
    expect(await kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
    expect(outsideHits).toEqual([]);
  });

  it('only detects a later hop of a popup chain (the documented limit of answerFirstHop): the run still ends scope_violation', async () => {
    const run = await open();
    const popup = run.page.context().waitForEvent('page');
    await run.page.evaluate(`window.open('${hopperUrl}/twice')`);
    await (await popup).waitForLoadState().catch(() => undefined);
    await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });

  it('opens a popup whose redirect stays in scope', async () => {
    const run = await open();
    const popup = run.page.context().waitForEvent('page');
    await run.page.evaluate(`window.open('${hopperUrl}/in')`);
    const p = await popup;
    await p.waitForURL(`${fixture.url}/map`);
    expect(await p.getByRole('heading', { name: 'Sơ đồ' }).count()).toBe(1);
    expect((await run.check()).passed).toBe(true);
    await run.finish({ status: 'passed' }, 0);
  });

  it('follows a hop that stays in scope', async () => {
    const run = await open();
    await run.page.evaluate(`location.href = '${hopperUrl}/in'`);
    await run.page.waitForURL(`${fixture.url}/map`);
    expect((await run.check()).passed).toBe(true);
    await run.finish({ status: 'passed' }, 0);
    expect(outsideHits).toEqual([]);
  });
});

describe('the redirect hold on a run that stays in scope', () => {
  it('keeps a run clean when the page aborts its own requests (AbortController, a navigation away)', async () => {
    const run = await open();
    await run.page.evaluate(`(async () => {
      for (let i = 0; i < 10; i++) {
        const c = new AbortController();
        const p = fetch('${hopperUrl}/slow?' + i, { signal: c.signal }).then((r) => r.text()).catch(() => {});
        await new Promise((r) => setTimeout(r, 5 * i));
        c.abort();
        await p;
      }
    })()`);
    await run.page.evaluate(`fetch('${hopperUrl}/slow?last').catch(() => {})`);
    await run.perform({ kind: 'goto', url: '/map' });
    expect((await run.check()).passed).toBe(true);
    const result = await run.finish({ status: 'passed' }, 0);
    expect(result.status).toBe('passed');
  });
});

describe('the redirect hold around popups and workers', () => {
  it('keeps a run clean when a popup closes before its hold is attached', async () => {
    const run = await open();
    for (let i = 0; i < 5; i++)
      await run.page.evaluate(`window.open('${hopperUrl}/in').close()`);
    await run.perform({ kind: 'goto', url: '/map' });
    expect((await run.check()).passed).toBe(true);
    expect((await run.finish({ status: 'passed' }, 0)).status).toBe('passed');
  });

  it('ends a run app_unreachable when a popup in scope cannot be fetched at all', async () => {
    const run = await open();
    const popup = run.page.context().waitForEvent('page');
    await run.page.evaluate(`window.open('${hopperUrl}/drop')`);
    await (await popup).waitForLoadState().catch(() => undefined);
    await expect.poll(() => kindOf(run.check(0))).toBe('app_unreachable');
    await run.finish({ status: 'passed' }, 0);
  });

  it('holds a dedicated worker to the scope: a request out of scope is stopped, a hop out of scope detected', async () => {
    const run = await open();
    const stopped = run.page.context().waitForEvent('requestfailed', {
      predicate: (r) => r.url().startsWith(outsideUrl),
      timeout: 5000,
    });
    await run.page.evaluate(`new Promise((done) => {
      const src = "fetch('${outsideUrl}/worker-direct').catch(() => {}).then(() => postMessage(1))";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = () => done();
      setTimeout(done, 3000);
    })`);
    await stopped;
    expect(outsideHits).toEqual([]);
    expect(await kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);

    const second = await open();
    await second.page.evaluate(`new Promise((done) => {
      const src = "fetch('${hopperUrl}/worker-hop').catch(() => {}).then(() => postMessage(1))";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = () => done();
      setTimeout(done, 3000);
    })`);
    await expect.poll(() => kindOf(second.check(0))).toBe('scope_violation');
    await second.finish({ status: 'passed' }, 0);
  });
});
