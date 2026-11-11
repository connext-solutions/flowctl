import { createServer, type Server } from 'node:http';
import { GUARD_PAGES, startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser, type Frame } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunSession } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';

/**
 * Frames under the scope guard (ADR 0024 section 3, rule 7, T1.2): a frame is a visit; one out of scope is not
 * entered and the run ends `scope_violation`. The fixture's `/guard/frames` page covers frames in the page's own
 * process; `side` is a second local server reached as `localhost`, another site than the fixture's `127.0.0.1`, so
 * under site isolation its frame runs in its own process (an out-of-process iframe), and its `/hop` answers 302 to
 * `outside`, which is never in scope.
 */
let fixture: Fixture;
let browser: Browser;
let isolated: Browser;
let side: Server;
let outside: Server;
let sideUrl = '';
let outsideUrl = '';
let outsideHits: string[] = [];

const listen = (s: Server, host: string): Promise<string> =>
  new Promise((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(`http://${host}:${typeof a === 'object' && a !== null ? a.port : 0}`);
    }),
  );

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  isolated = await chromium.launch({ args: ['--site-per-process'] });
  outside = createServer((req, res) => {
    outsideHits.push(req.url ?? '');
    res.end('outside');
  });
  outsideUrl = await listen(outside, '127.0.0.1');
  side = createServer((req, res) => {
    if ((req.url ?? '').startsWith('/hop')) {
      res.writeHead(302, { location: `${outsideUrl}/hop` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<p>side ${req.url ?? ''}</p>`);
  });
  sideUrl = await listen(side, 'localhost');
});
afterAll(async () => {
  await browser.close();
  await isolated.close();
  await new Promise((r) => side.close(r));
  await new Promise((r) => outside.close(r));
  await fixture.close();
});
beforeEach(() => {
  outsideHits = [];
});

const FLOW = {
  name: 'frames-flow',
  goal: 'g',
  profile: 'employee',
  start: GUARD_PAGES.frames,
  steps: [{ wait: 10 }],
  assertions: [{ text: 'Khung' }],
};

async function open(
  opts: { deny?: string[]; on?: Browser } = {},
): Promise<RunSession> {
  const cfg = fixtureConfig(fixture.url, {
    target: { scope: { deny: opts.deny ?? [] } },
  });
  const sets = [fixture.url, sideUrl];
  cfg.trustView = {
    refused: {},
    scopes: { local: { visit: sets, call: sets } },
  };
  await seedProfiles(cfg, fixture.url);
  const run = RunSession.open(cfg, writeFlow(cfg, FLOW), {
    browser: opts.on ?? browser,
  });
  await run.begin();
  return run;
}

const click = (run: RunSession, name: string) =>
  run.perform({ kind: 'click', target: { role: 'button', name } });

const kindOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error && 'kind' in e ? String(e.kind) : String(e);
  }
  return undefined;
};

/** Adds a frame of `src` to the run's page and returns it once it shows `src`. */
async function addFrame(run: RunSession, src: string): Promise<Frame> {
  await run.page.evaluate(`new Promise((done) => {
    const f = Object.assign(document.createElement('iframe'), { src: '${src}' });
    f.onload = () => done();
    document.body.append(f);
  })`);
  const frame = run.page.frames().find((f) => f.url() === src);
  if (frame === undefined) throw new Error(`no frame shows ${src}`);
  return frame;
}

describe('frames in the page process', () => {
  it('lets a page with a frame in scope pass', async () => {
    const run = await open();
    expect((await run.check()).passed).toBe(true);
    expect((await run.finish({ status: 'passed' }, 0)).status).toBe('passed');
  });

  it('refuses a frame on another origin: scope_violation, the frame is not entered', async () => {
    const run = await open();
    expect(await kindOf(click(run, 'Khung ngoài'))).toBe('scope_violation');
    expect(run.page.frames().map((f) => f.url())).not.toContain(
      GUARD_PAGES.offScopeFrame,
    );
    await run.finish({ status: 'passed' }, 0);
  });

  it('detects a data: frame, which sends no request: scope_violation', async () => {
    const run = await open();
    await click(run, 'Khung dữ liệu').catch(() => undefined);
    await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });

  it('detects a frame moved to a denied hash route, which sends no request', async () => {
    const run = await open({ deny: ['/admin/**'] });
    await click(run, 'Khung sang cài đặt').catch(() => undefined);
    await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });
});

describe('a cross-site frame in its own process (site isolation on)', () => {
  it('runs the frame in its own process (the premise of this block)', async () => {
    const run = await open({ on: isolated });
    const frame = await addFrame(run, `${sideUrl}/frame`);
    const own = await run.page.context().newCDPSession(frame);
    await own.detach();
    expect((await run.check()).passed).toBe(true);
    await run.finish({ status: 'passed' }, 0);
  });

  it('stops the frame navigating itself out of scope before the request leaves', async () => {
    const run = await open({ on: isolated });
    const frame = await addFrame(run, `${sideUrl}/frame`);
    await frame
      .evaluate(`location.href = '${outsideUrl}/direct'`)
      .catch(() => undefined);
    await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
    expect(outsideHits).toEqual([]);
  });

  it.each([
    ['its first navigation', 'src'],
    ['a later navigation of its own', 'self'],
  ])(
    'stops a redirect hop out of scope in %s before the hop is sent',
    async (_what, how) => {
      const run = await open({ on: isolated });
      if (how === 'src')
        await run.page
          .evaluate(
            `document.body.append(Object.assign(document.createElement('iframe'), { src: '${sideUrl}/hop' }))`,
          )
          .catch(() => undefined);
      else {
        const frame = await addFrame(run, `${sideUrl}/frame`);
        await frame
          .evaluate(`location.href = '${sideUrl}/hop'`)
          .catch(() => undefined);
      }
      await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
      await run.finish({ status: 'passed' }, 0);
      expect(outsideHits).toEqual([]);
    },
  );
});
