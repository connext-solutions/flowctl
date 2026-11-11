import { GUARD_PAGES, startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser, type Frame } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_ROUTE_APIS } from '../src/run/context-limits.js';
import { RunSession } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';

/**
 * WebRTC and WebTransport in a run (ADR 0024 section 3, rule 6): no route sees them, so an init script disables them
 * in every frame. This is **best effort**: the last test pins what it does not reach, so no WebRTC or WebTransport
 * call may ever be part of a verdict.
 */
let fixture: Fixture;
let browser: Browser;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

const FLOW = {
  name: 'webrtc-flow',
  goal: 'g',
  profile: 'employee',
  start: GUARD_PAGES.frames,
  steps: [{ wait: 10 }],
  assertions: [{ text: 'Khung' }],
};

async function open(): Promise<RunSession> {
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  const run = RunSession.open(cfg, writeFlow(cfg, FLOW), { browser });
  await run.begin();
  return run;
}

/** What `new <name>(…)` does in `where`, after the page tried to put the original back. */
const tryOpen = (where: { evaluate: Frame['evaluate'] }, name: string) =>
  where.evaluate(`(() => {
    try { globalThis['${name}'] = function () {}; } catch {}
    try {
      new globalThis['${name}']('https://127.0.0.1:1/x');
      return 'opened';
    } catch (e) {
      return e.name;
    }
  })()`);

describe('WebRTC and WebTransport in a run (best effort)', () => {
  it.each(['RTCPeerConnection', 'WebTransport'])(
    'throws NotAllowedError for new %s in the page and in a frame, and the page cannot restore it',
    async (name) => {
      expect(NO_ROUTE_APIS).toContain(name);
      const run = await open();
      expect(await tryOpen(run.page, name)).toBe('NotAllowedError');
      const inner = run.page
        .frames()
        .find((f) => f.url().endsWith(GUARD_PAGES.frameInScope));
      expect(inner).toBeDefined();
      if (inner !== undefined)
        expect(await tryOpen(inner, name)).toBe('NotAllowedError');
      expect((await run.check()).passed).toBe(true);
      await run.finish({ status: 'passed' }, 0);
    },
  );

  it('reaches a frame the page adds and uses at once (about:blank, before any load)', async () => {
    const run = await open();
    const fresh = await run.page.evaluate(`(() => {
      const f = document.createElement('iframe');
      document.body.append(f);
      try {
        new f.contentWindow.RTCPeerConnection();
        return 'opened';
      } catch (e) {
        return e.name;
      }
    })()`);
    expect(fresh).toBe('NotAllowedError');
    await run.finish({ status: 'passed' }, 0);
  });

  it('does not reach a worker: WebTransport stays there (the documented limit of rule 6)', async () => {
    const run = await open();
    const inWorker = await run.page.evaluate(`new Promise((done) => {
      const src = "postMessage(typeof WebTransport)";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => done(e.data);
      setTimeout(() => done('no answer'), 3000);
    })`);
    expect(inWorker).toBe('function');
    await run.finish({ status: 'passed' }, 0);
  });
});
