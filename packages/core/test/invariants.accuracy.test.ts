import {
  INVARIANT_BUG_MODES,
  startFixture,
  type CrawlBugMode,
  type InvariantBugMode,
} from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVARIANT_IDS,
  evaluateInvariant,
  type InvariantEvidence,
  type InvariantId,
} from '../src/derive/index.js';
import { observe } from '../src/observe/index.js';
import { driveItems } from './derive/invariants-drive.js';
import { PARAMS } from './derive/invariants-fixture.js';
import { fixtureConfig, seedProfiles } from './helpers.js';

/**
 * Which invariant catches each seeded bug of the `/items` app (T4.9, ADR 0041), and which invariants may not bind
 * because the defect leaves them nothing to read.
 *
 * @remarks Written from the defect, never from a run. Each mode is caught by exactly one invariant, so removing that
 *   invariant lets the mode pass unnoticed: each template is load-bearing. `reloadLosesData` leaves nothing to read
 *   back, so `round-trip-equality` has no evidence there and refuses (a refusal is not a pass).
 */
const CAUGHT_BY: Record<
  InvariantBugMode,
  { must: InvariantId; refused?: InvariantId[] }
> = {
  createNotListed: { must: 'crud-create-appears' },
  editNotShown: { must: 'crud-edit-shows' },
  deleteStillListed: { must: 'crud-delete-absent' },
  reloadLosesData: {
    must: 'reload-keeps-data',
    refused: ['round-trip-equality'],
  },
  readBackAltered: { must: 'round-trip-equality' },
  itemApproveNoop: { must: 'state-change-after-action' },
  toastOnConflict: { must: 'success-toast-implies-2xx' },
  clientLimitMissing: { must: 'client-blocks-what-server-rejects' },
};

/** The crawl-class modes that seed the two free invariants. */
const FREE_CAUGHT_BY: [CrawlBugMode, InvariantId][] = [
  ['page500', 'no-5xx'],
  ['call500', 'no-5xx'],
  ['pageConsoleError', 'no-console-error'],
];

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

/** Crawls `start` of a fixture started with `bug` and returns the evidence the drive adds to, when it drives. */
async function evidenceOf(
  bug: InvariantBugMode | CrawlBugMode | undefined,
  start: string,
  drive: boolean,
): Promise<InvariantEvidence> {
  const fixture = await startFixture(bug);
  try {
    const cfg = fixtureConfig(fixture.url, {
      target: { scope: { deny: ['/admin/**'] } },
    });
    await seedProfiles(cfg, fixture.url);
    const { map } = await observe(cfg, { browser, start });
    if (!drive) return { map, inputs: {} };
    const d = await driveItems(browser, fixture.url);
    return { map, drive: d.record, inputs: d.inputs };
  } finally {
    await fixture.close();
  }
}

/** Every invariant's outcome on `evidence`, with the page of the map as its parameter: which found something. */
function verdicts(evidence: InvariantEvidence) {
  const found: InvariantId[] = [];
  const refused: InvariantId[] = [];
  for (const id of INVARIANT_IDS) {
    const r = evaluateInvariant(id, evidence, PARAMS[id]);
    if (!r.ok) refused.push(id);
    else if (r.findings.length > 0) found.push(id);
  }
  return { found, refused };
}

describe('invariants accuracy on /items', () => {
  it('finds nothing on the clean app', async () => {
    const v = verdicts(await evidenceOf(undefined, '/items', true));
    expect(v).toEqual({ found: [], refused: [] });
  });

  it.each([...INVARIANT_BUG_MODES])(
    'finds the seeded bug %s with its own invariant and no other',
    async (bug) => {
      const v = verdicts(await evidenceOf(bug, '/items', true));
      const expected = CAUGHT_BY[bug];
      expect(v.found).toEqual([expected.must]);
      expect(v.refused).toEqual(expected.refused ?? []);
    },
  );

  it('has a mode for each of the eight drive invariants', () => {
    expect(
      Object.values(CAUGHT_BY)
        .map((c) => c.must)
        .sort(),
    ).toEqual(INVARIANT_IDS.filter((id) => !id.startsWith('no-')).sort());
  });
});

describe('invariants accuracy on the crawl modes', () => {
  it('finds nothing on the clean /map', async () => {
    const e = await evidenceOf(undefined, '/map', false);
    for (const id of ['no-5xx', 'no-console-error'] as const)
      expect(evaluateInvariant(id, e, {})).toEqual({ ok: true, findings: [] });
  });

  it.each(FREE_CAUGHT_BY)('finds %s with %s', async (bug, id) => {
    const e = await evidenceOf(bug, '/map', false);
    const r = evaluateInvariant(id, e, {});
    expect(r.ok && r.findings.length).toBeGreaterThan(0);
    if (id === 'no-console-error')
      expect(evaluateInvariant('no-5xx', e, {})).toEqual({
        ok: true,
        findings: [],
      });
  });
});
