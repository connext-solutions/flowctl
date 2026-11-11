import { readFileSync } from 'node:fs';
import {
  CRAWL_BUG_MODES,
  startFixture,
  type CrawlBugMode,
} from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FreeChecksSchema,
  observe,
  type CheckFinding,
  type CheckId,
  type Observation,
} from '../src/observe/index.js';
import { fixtureConfig, seedProfiles } from './helpers.js';

/** A finding as the ground truth names it: the check and the page it is on. */
type Hit = `${CheckId} ${string}`;

/**
 * Which free checks must catch each crawl-class seeded bug (T2.6), on which page, and the only pages a finding may be
 * on: the page the bug breaks and the pages that link to it.
 *
 * @remarks Written from the defect, never from a run. The browser also logs a failed document load or a failed call
 *   as a console error on the broken page; that page is in `pages`, so such a line is allowed but not required.
 *   `no-broken-link` re-reports the failure of the target page from each page that links to it, so it has no seeded
 *   bug of its own: it is required next to the target's check. `call404` is a documented non-detection: a 4xx
 *   fetch/xhr call is not judged until an allow-list of expected statuses exists (ADR 0033 amendment 2026-11-12), so
 *   no status check may report it.
 */
const CAUGHT_BY: Record<
  CrawlBugMode,
  { must: Hit[]; pages: string[]; never?: CheckId[] }
> = {
  brokenLink: {
    must: ['no-4xx /map/missing', 'no-broken-link /map'],
    pages: ['/map', '/map/missing'],
  },
  page500: {
    must: ['no-5xx /map/report', 'no-broken-link /map'],
    pages: ['/map', '/map/report'],
  },
  pageConsoleError: {
    must: ['no-console-error /map/report'],
    pages: ['/map/report'],
  },
  pageNoAnswer: {
    must: ['no-unreachable-page /map/down', 'no-broken-link /map'],
    pages: ['/map', '/map/down'],
  },
  call500: {
    must: ['no-5xx /map/report'],
    pages: ['/map/report'],
  },
  call404: {
    must: [],
    pages: ['/map/report'],
    never: ['no-4xx', 'no-5xx', 'no-broken-link', 'no-unreachable-page'],
  },
};

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** Crawls `/map` of a fixture started with `bug` (or none) and returns the observation. */
async function crawl(bug?: CrawlBugMode): Promise<Observation> {
  const fixture = await startFixture(bug);
  try {
    const cfg = fixtureConfig(fixture.url, {
      target: { scope: { deny: ['/admin/**'] } },
    });
    await seedProfiles(cfg, fixture.url);
    return await observe(cfg, { browser, start: '/map' });
  } finally {
    await fixture.close();
  }
}

/** The value `pointer` (RFC 6901, no escapes: map paths hold none in the pointed-at keys) names in `doc`. */
function resolve(doc: unknown, pointer: string): unknown {
  let at: unknown = doc;
  for (const key of pointer.split('/').slice(1)) {
    if (typeof at !== 'object' || at === null) return undefined;
    at = Object.entries(at).find(([k]) => k === key)?.[1];
  }
  return at;
}

/**
 * Checks that `f.observation.pointer` names, in the `appmap.json` on disk, the value the finding reports, on the
 * page it names: the status, the console line, the link target, or the call (method, path, origin) with its status.
 */
function expectPointsAtItsValue(f: CheckFinding, appmap: unknown): void {
  const { pointer } = f.observation;
  const page = /^\/pages\/\d+/.exec(pointer)?.[0] ?? '';
  expect(resolve(appmap, `${page}/path`), pointer).toBe(f.page);
  const value = resolve(appmap, pointer);
  if (pointer.endsWith('/status')) expect(value, pointer).toBe(f.status);
  else if (pointer.includes('/consoleErrors/'))
    expect(value, pointer).toBe(f.message);
  else expect(value, pointer).toBe(f.target);
  if (f.call !== undefined)
    expect(resolve(appmap, pointer.replace(/\/status$/, '')), pointer).toEqual({
      ...f.call,
      status: f.status,
    });
}

const findings = (o: Observation): CheckFinding[] =>
  o.checks?.result.checks.flatMap((c) => c.findings) ?? [];
const hit = (f: CheckFinding): Hit => `${f.check} ${f.page}`;

/** The free checks (T2.4) on the fixture's crawl: every crawl-class bug found, nothing found on the clean app. */
describe('free checks accuracy', () => {
  it('finds nothing on the clean app, decoys and refused redirect included', async () => {
    const o = await crawl();
    expect(o.run.status).toBe('passed');
    expect(o.checks?.result.status).toBe('passed');
    expect(findings(o)).toEqual([]);
    expect(
      FreeChecksSchema.parse(
        JSON.parse(readFileSync(o.checks?.file ?? '', 'utf8')),
      ),
    ).toEqual(o.checks?.result);
  });

  it.each([...CRAWL_BUG_MODES])(
    'finds the seeded bug %s, and only on the pages it breaks',
    async (bug) => {
      const o = await crawl(bug);
      const expected = CAUGHT_BY[bug];
      expect(o.run.status).toBe('passed');
      if (expected.must.length > 0)
        expect(o.checks?.result.status).toBe('failed');
      const got = findings(o);
      expect(got.map(hit)).toEqual(expect.arrayContaining(expected.must));
      const appmap: unknown = JSON.parse(readFileSync(o.file, 'utf8'));
      for (const f of got) {
        expect(expected.pages, hit(f)).toContain(f.page);
        expect(expected.never ?? [], hit(f)).not.toContain(f.check);
        expect(f.sourceRef).toEqual({ kind: 'invariant', ref: f.check });
        expect(f.observation.file).toBe('appmap.json');
        expectPointsAtItsValue(f, appmap);
      }
    },
  );

  it('reports /map/down unreachable although the late refusal of /map landed on it (pageNoAnswer)', async () => {
    const o = await crawl('pageNoAnswer');
    expect(o.map.pages.find((p) => p.path === '/map/down')).toMatchObject({
      status: 0,
      refused: ['destructive_blocked'],
      navigationRefused: false,
    });
    expect(findings(o).map(hit)).toContain('no-unreachable-page /map/down');
  });

  it('documents a non-detection: a 404 call is in the map and no status check reports it (call404)', async () => {
    const o = await crawl('call404');
    expect(
      o.map.pages.find((p) => p.path === '/map/report')?.calls,
    ).toContainEqual({ method: 'GET', path: '/map/api/summary', status: 404 });
    for (const id of ['no-4xx', 'no-5xx'] as const)
      expect(o.checks?.result.checks.find((c) => c.id === id)?.status).toBe(
        'passed',
      );
  });
});
