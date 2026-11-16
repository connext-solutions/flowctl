import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TraceMode } from '../src/result.js';
import { DRAFT_PROVENANCE, outcomeOf, RunSession } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';
import { allowEnvVars, testStore } from './trust-fixture.js';

/**
 * Evidence safe to share (ADR 0030, issues #10, #11): a flow types a secret input into "Lý do" and submits it, so
 * the secret is sent in a POST body, echoed in the 201 answer and shown in the list. Nothing in the run directory
 * may hold it in clear, nor the session cookie (`role=employee`), unless the run asked for a full trace.
 */
let fixture: Fixture;
let browser: Browser;
const SECRET = 'Mk-s3cr3t-7731';

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

/** Every file of the run directory, with each trace zip unpacked, as one text per file name. */
function runFiles(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name.endsWith('.zip')) {
      const list = execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' });
      for (const entry of list.split('\n').filter(Boolean))
        out.set(
          `${name}:${entry}`,
          execFileSync('unzip', ['-p', path, entry], {
            encoding: 'latin1',
            maxBuffer: 64 * 1024 * 1024,
          }),
        );
    } else out.set(name, readFileSync(path, 'latin1'));
  }
  return out;
}

async function run(trace?: TraceMode, logList = false) {
  process.env['FLOWCTL_TEST_REASON'] = SECRET;
  try {
    const cfg = fixtureConfig(fixture.url);
    await seedProfiles(cfg, fixture.url);
    const flow = writeFlow(cfg, {
      name: 'redaction-flow',
      goal: 'g',
      profile: 'employee',
      start: '/requests',
      inputs: { reason: { env: 'FLOWCTL_TEST_REASON' } },
      steps: [
        { fill: { role: 'textbox', name: 'Lý do' }, input: 'reason' },
        { click: { role: 'button', name: 'Gửi' } },
      ],
      assertions: [
        { text: 'Đã gửi đơn', within: { role: 'status' } },
        { text: 'Đơn từ' },
        { network: { method: 'POST', url: '/api/requests', status: 500 } },
      ],
    });
    const store = allowEnvVars(testStore(cfg), 'employee', [
      'FLOWCTL_TEST_REASON',
    ]);
    const r = RunSession.open(cfg, flow, {
      browser,
      store,
      trace,
      provenance: DRAFT_PROVENANCE,
    });
    await r.begin();
    for (const step of r.steps) await r.perform(step);
    const verdict = await r.check(2000);
    if (logList)
      await r.page.evaluate(
        "console.error('list says ' + document.querySelector('#rows').innerText)",
      );
    const sent = r.evidence.network.find((e) => e.method === 'POST');
    return { result: await r.finish(outcomeOf(verdict), 2), sent };
  } finally {
    delete process.env['FLOWCTL_TEST_REASON'];
  }
}

describe('evidence safe to share (ADR 0030)', () => {
  it('types the secret, verifies on it in memory, and keeps it and the session cookie out of every file', async () => {
    const { result, sent } = await run();
    expect(sent?.requestBody).toMatchObject({ reason: SECRET });
    expect(result.status).toBe('failed');
    expect(result.evidence.trace).toBe('safe');
    const files = runFiles(result.evidence.dir);
    expect([...files.keys()].some((k) => k.endsWith('trace.trace'))).toBe(true);
    const leaks = [...files.entries()]
      .filter(
        ([, text]) => text.includes(SECRET) || text.includes('role=employee'),
      )
      .map(([name]) => name);
    expect(leaks).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(files.get('network.json')).toContain('***');
  });

  it('masks a secret the app prints to the console in console.json and the result (the trace keeps console text: a stated limit)', async () => {
    const { result } = await run(undefined, true);
    const files = runFiles(result.evidence.dir);
    expect(files.get('console.json')).toContain('list says');
    expect(files.get('console.json')).not.toContain(SECRET);
    expect(JSON.stringify(result.evidence.console)).not.toContain(SECRET);
  });

  it('records DOM snapshots only when the run asks for a full trace, and says so in run.json', async () => {
    const { result } = await run('full');
    expect(result.evidence.trace).toBe('full');
    const files = runFiles(result.evidence.dir);
    expect([...files.keys()].some((k) => k.includes(':resources/'))).toBe(true);
    expect(files.get('network.json')).not.toContain(SECRET);
  });
});
