import { readFileSync } from 'node:fs';
import {
  ECHO_PREFILL,
  startFakeSystem1,
  startFixture,
  type FakeSystem1,
  type Fixture,
} from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExploreStop } from '../../src/explore/index.js';
import { Exploration, type ExploreRequest } from '../../src/explore/index.js';
import { saveExploration, type SaveResult } from '../../src/save.js';
import { VARS, exploreConfig, seedProfiles } from '../helpers.js';
import { allowEnvVars, testStore } from '../trust-fixture.js';
import {
  CHECK,
  HOLDING,
  NOTE,
  PASSWORD,
  SECRET_ENV,
  withSecret,
} from './echo-flow.js';
import { findSecret, freshSecret } from './find-secret.js';
import { leaksIn, runOutputs } from './scan.js';

/**
 * A known secret never leaves an exploration or the confirming replay that saves it (T1.5, invariants 4 and 5,
 * ADR 0006, ADR 0030). The orchestrator types the secret input into the password field "Mật khẩu" (password
 * fields never reach a snapshot, so System 1 cannot pick them); the fake System 1 has it typed into "Ghi chú" by its
 * key, then sends the form, so the page shows the secret, its URL holds it and a call carries it. Every file of both
 * run directories, the saved flow, the results and every request the fake System 1 received (URL, headers and body
 * as they arrived) are scanned.
 *
 * @remarks Scope today: no automated form login (T1.4); a secret reaches the page only as a flow input. Trace lines
 *   are scanned as `scrubTraceLine` in `scan.ts` leaves them, which says what it leaves out and why.
 */
let fixture: Fixture;
let browser: Browser;
let s1: FakeSystem1;
const secret = freshSecret();
let stop: ExploreStop;
let saved: SaveResult;

const REQUEST: ExploreRequest = {
  goal: 'Kiểm tra mật khẩu và ghi chú',
  start: '/echo',
  profile: 'employee',
  inputs: { pw: { env: SECRET_ENV } },
  assertions: HOLDING,
};

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
  s1 = await startFakeSystem1([
    { op: 'TYPE_TEXT', target: NOTE.name, input: 'pw' },
    { op: 'CLICK', target: CHECK.name },
    { op: 'DONE' },
  ]);
  const cfg = exploreConfig(fixture.url, s1.url);
  await seedProfiles(cfg, fixture.url);
  const store = allowEnvVars(testStore(cfg), 'employee', [SECRET_ENV]);
  await withSecret(secret, async () => {
    const x = await Exploration.start(cfg, REQUEST, {
      browser,
      vars: VARS,
      store,
    });
    stop = await x.step([{ kind: 'fill', target: PASSWORD, input: 'pw' }]);
    saved = await saveExploration(cfg, x, {
      name: 'redaction-explore',
      browser,
      store,
    });
  });
});
afterAll(async () => {
  await s1.close();
  await browser.close();
  await fixture.close();
});

describe('an exploration with a secret input, and its save (T1.5)', () => {
  it('passed and was saved, after System 1 typed the secret by its key and the app echoed it', () => {
    expect(stop.status, JSON.stringify(stop)).toBe('passed');
    expect(saved.saved).toBe(true);
    expect(saved.replay.status).toBe('passed');
    expect(s1.requests.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(s1.requests)).toContain('***');
  });

  it('sends System 1 no form of the secret in any request, URL and headers included', () => {
    expect(s1.raw).toHaveLength(s1.requests.length);
    const sent = s1.raw.map((r, i): [string, string] => [
      `System 1 request ${i}`,
      r,
    ]);
    expect(leaksIn(sent, secret)).toEqual([]);
  });

  it('never shows System 1 a password field or its value, not even one the run did not type', () => {
    for (const text of s1.raw) {
      expect(findSecret(text, ECHO_PREFILL)).toEqual([]);
      expect(text).not.toContain(`] ${PASSWORD.name}`);
      expect(text).not.toContain('] Mã cũ');
    }
  });

  it('leaves no form of the secret in the exploration run directory (decisions.jsonl included)', () => {
    if (stop.status !== 'passed') throw new Error(JSON.stringify(stop));
    const files = runOutputs(stop.evidence.dir);
    expect(files.map(([n]) => n)).toEqual(
      expect.arrayContaining(['run.json', 'decisions.jsonl', 'network.json']),
    );
    expect(leaksIn(files, secret)).toEqual([]);
  });

  it('leaves no form of the secret in the confirming replay run directory', () => {
    expect(leaksIn(runOutputs(saved.replay.evidence.dir), secret)).toEqual([]);
  });

  it('saves the flow with the input by its variable name and no form of the secret', () => {
    const yaml = readFileSync(saved.file ?? '', 'utf8');
    expect(yaml).toContain(SECRET_ENV);
    expect(leaksIn([['saved flow', yaml]], secret)).toEqual([]);
  });

  it('returns no form of the secret in the stop or the save result', () => {
    const out: [string, string][] = [
      ['stop', JSON.stringify(stop)],
      ['save', JSON.stringify(saved)],
    ];
    expect(leaksIn(out, secret)).toEqual([]);
  });
});
