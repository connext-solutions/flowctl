import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { matchOperations } from '../../src/derive/index.js';
import { observe, type AppMap } from '../../src/observe/index.js';
import {
  markdownSpecProvider,
  type Operation,
  SpecRegistry,
} from '../../src/spec/index.js';
import { openRoot } from '../../src/trust/index.js';
import { fixtureConfig, seedProfiles } from '../helpers.js';
import { assertGrounded } from './build.js';
import { FIXTURE_TRUTH } from './fixture-truth.js';

/**
 * The matcher on the real fixture (T4.1): the crawl of fixture-app joined with its markdown spec maps every
 * operation the seeded-bug index names to the screen and controls written down in `fixture-truth.ts`.
 */
const SPEC = fileURLToPath(
  new URL('../../../fixture-app/spec', import.meta.url),
);
const index: Record<string, { doc: string }> = JSON.parse(
  readFileSync(join(SPEC, 'index.json'), 'utf8'),
);

let fixture: Fixture;
let browser: Browser;
let map: AppMap;
let ops: Operation[];

/**
 * Two crawls: the employee from `/map` (the leave pages and `/map/*`), and the manager from `/approvals`, which the
 * crawl never follows a link to (ADR 0033: "Phê duyệt" holds a destructive word). Pages are merged by path.
 */
beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  const a = await observe(cfg, { browser, start: '/map' });
  const b = await observe(cfg, {
    browser,
    start: '/approvals',
    profile: 'manager',
  });
  const seen = new Set(a.map.pages.map((p) => p.path));
  map = {
    ...a.map,
    pages: [...a.map.pages, ...b.map.pages.filter((p) => !seen.has(p.path))],
  };
  const registry = new SpecRegistry();
  registry.register(markdownSpecProvider(openRoot(SPEC, 'specs')));
  ops = await registry.operations('markdown');
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

describe('matcher on fixture-app (T4.1)', () => {
  it('maps every operation of the seeded-bug index to its true screen and controls', () => {
    const report = matchOperations(ops, map);
    assertGrounded(report, ops, map);
    const docs = [...new Set(Object.values(index).map((e) => e.doc))].sort();
    expect(docs).toEqual(Object.keys(FIXTURE_TRUTH).sort());
    for (const doc of docs) {
      const truth = FIXTURE_TRUTH[doc];
      const m = report.operations.find((o) => o.operation.ref === doc);
      expect(m?.screen, doc).toEqual({
        status: 'matched',
        page: truth?.screen,
      });
      const onScreen = (m?.literals ?? [])
        .map((l) => ({
          ...l,
          elements: l.elements.filter((e) => e.element.page === truth?.screen),
        }))
        .filter((l) => l.elements.length > 0);
      expect(
        onScreen
          .filter((l) => l.kind === 'label')
          .map((l) => l.text)
          .sort(),
        doc,
      ).toEqual(Object.keys(truth?.labels ?? {}).sort());
      for (const l of onScreen.filter((x) => x.kind === 'label'))
        for (const role of truth?.labels[l.text] ?? [])
          expect(
            l.elements.some(
              (e) => 'role' in e.element && e.element.role === role,
            ),
            `${doc} ${l.text} ${role}`,
          ).toBe(true);
      expect(
        onScreen.filter((l) => l.kind === 'path').map((l) => l.text),
        doc,
      ).toEqual(truth?.paths);
      expect(m?.unmatchedSteps, doc).toEqual([]);
    }
  });

  it('gives the same report for the same crawl and spec twice', () => {
    expect(matchOperations(ops, map)).toEqual(
      matchOperations([...ops].reverse(), map),
    );
  });
});
