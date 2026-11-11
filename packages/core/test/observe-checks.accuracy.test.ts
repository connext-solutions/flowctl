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
 * @remarks Written from the defect, never from a run. The browser also logs a failed document load as a console
 *   error on the broken page; that page is in `pages`, so such a line is allowed but not required.
 */
const CAUGHT_BY: Record<CrawlBugMode, { must: Hit[]; pages: string[] }> = {
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
      expect(o.checks?.result.status).toBe('failed');
      const got = findings(o);
      expect(got.map(hit)).toEqual(expect.arrayContaining(expected.must));
      for (const f of got) {
        expect(expected.pages, hit(f)).toContain(f.page);
        expect(f.sourceRef).toEqual({ kind: 'invariant', ref: f.check });
        expect(f.observation.file).toBe('appmap.json');
      }
    },
  );
});
