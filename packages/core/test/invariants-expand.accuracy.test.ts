import {
  startFixture,
  type CrawlBugMode,
  type InvariantBugMode,
} from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  INVARIANT_IDS,
  expandInvariant,
  type InvariantEvidence,
  type InvariantId,
} from '../src/derive/index.js';
import type { Assertion } from '../src/flow/index.js';
import { observe } from '../src/observe/index.js';
import { replayFlow } from '../src/replay.js';
import type { RunResult } from '../src/result.js';
import { driveItems } from './derive/invariants-drive.js';
import { LIST, PARAMS } from './derive/invariants-fixture.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';

/** A flow of one invariant case: its steps and inputs, an assertion every mode passes, and where it starts. */
interface Case {
  id: InvariantId;
  bug: InvariantBugMode | CrawlBugMode;
  start: string;
  inputs: Record<string, { value: string }>;
  steps: unknown[];
  base: Assertion;
  /** What the failed assertion of the seeded run must hold, written from the defect. */
  failed: Record<string, unknown>;
}

const CREATE_STEPS = [
  { fill: { role: 'textbox', name: 'Tên mục' }, input: 'name' },
  { click: { role: 'button', name: 'Tạo' } },
];

/**
 * Every template that expands, with the flow its assertion goes into and the seeded mode it must catch (ADR 0041
 * section 5 and 6). The `base` assertion holds in every mode, so a flow without the expansion passes.
 */
const CASES: Case[] = [
  {
    id: 'crud-create-appears',
    bug: 'createNotListed',
    start: '/items',
    inputs: { name: { value: 'QA-{{uid}}' } },
    steps: CREATE_STEPS,
    base: { network: { method: 'POST', url: '**/api/items', status: 201 } },
    failed: { within: LIST },
  },
  {
    id: 'crud-edit-shows',
    bug: 'editNotShown',
    start: '/items',
    inputs: {
      name: { value: 'QA-{{uid}}' },
      rename: { value: 'QA-{{uid}}-e' },
    },
    steps: [
      ...CREATE_STEPS,
      { fill: { role: 'textbox', name: 'Tên mới' }, input: 'rename' },
      { click: { role: 'button', name: 'Sửa' } },
    ],
    base: { network: { method: 'PATCH', url: '**/api/items/*', status: 200 } },
    failed: { within: LIST },
  },
  {
    id: 'no-console-error',
    bug: 'pageConsoleError',
    start: '/map/report',
    inputs: {},
    steps: [{ reload: true }],
    base: { text: 'Báo cáo' },
    failed: { noConsoleErrors: true },
  },
];

let browser: Browser;
let evidence: InvariantEvidence;

beforeAll(async () => {
  browser = await chromium.launch();
  const clean = await startFixture();
  try {
    const cfg = fixtureConfig(clean.url, {
      target: { scope: { deny: ['/admin/**'] } },
    });
    await seedProfiles(cfg, clean.url);
    const { map } = await observe(cfg, { browser, start: '/items' });
    const d = await driveItems(browser, clean.url);
    evidence = { map, drive: d.record, inputs: d.inputs };
  } finally {
    await clean.close();
  }
});
afterAll(async () => {
  await browser.close();
});

/** The assertion invariant `id` expands to on the clean app's evidence. */
function expansion(id: InvariantId): Assertion {
  const r = expandInvariant(id, evidence, PARAMS[id]);
  if (!r.ok) throw new Error(`${id} does not expand: ${r.detail}`);
  return r.assertion;
}

/**
 * Replays the flow of `c` with `assertions` against a fresh fixture started with `bug` (the clean app when
 * `undefined`), so each replay sees an empty `/items` and its locators match one row.
 */
async function replayOn(
  bug: Case['bug'] | undefined,
  c: Case,
  assertions: Assertion[],
): Promise<RunResult> {
  const fixture = await startFixture(bug);
  try {
    return await replayIn(fixture.url, c, assertions);
  } finally {
    await fixture.close();
  }
}

async function replayIn(
  url: string,
  c: Case,
  assertions: Assertion[],
): Promise<RunResult> {
  const cfg = fixtureConfig(url);
  await seedProfiles(cfg, url);
  const flow = writeFlow(cfg, {
    name: `inv-${c.id}`,
    goal: 'Kiểm tra một bất biến',
    profile: 'employee',
    start: c.start,
    derived: true,
    inputs: c.inputs,
    steps: c.steps,
    assertions,
  });
  return replayFlow(cfg, flow, { browser });
}

describe('each expansion catches its own seeded bug', () => {
  it('covers exactly the templates that expand', () => {
    const expandable = INVARIANT_IDS.filter(
      (id) => expandInvariant(id, evidence, PARAMS[id]).ok,
    );
    expect(expandable).toEqual(CASES.map((c) => c.id));
  });

  it.each(CASES.map((c) => [c.id, c] as const))(
    '%s: the seeded mode fails on it, passes without it, and the clean app passes',
    async (_id, c) => {
      const assertion = expansion(c.id);
      const caught = await replayOn(c.bug, c, [c.base, assertion]);
      expect(caught.status).toBe('failed');
      expect(caught.failed).toMatchObject({ assertion: c.failed });
      const missed = await replayOn(c.bug, c, [c.base]);
      expect(missed.status).toBe('passed');
      const passed = await replayOn(undefined, c, [c.base, assertion]);
      expect(passed.status).toBe('passed');
    },
  );
});
