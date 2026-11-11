import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GUARD_PAGES, startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunResult } from '../src/result.js';
import { RunSession } from '../src/run/index.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';

/**
 * Downloads under the scope guard (ADR 0024 section 3 rule 6, T1.2): a run never saves a download, a download is a
 * request held to the scope like any other, and a cancelled download is noted in `network.json`, never a failure.
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
  name: 'downloads-flow',
  goal: 'g',
  profile: 'employee',
  start: GUARD_PAGES.downloads,
  steps: [{ wait: 10 }],
  assertions: [{ text: 'Tải xuống' }],
};

async function open(
  extra: Record<string, unknown> = {},
  assertions: unknown[] = FLOW.assertions,
): Promise<RunSession> {
  const cfg = fixtureConfig(fixture.url, extra);
  await seedProfiles(cfg, fixture.url);
  const run = RunSession.open(cfg, writeFlow(cfg, { ...FLOW, assertions }), {
    browser,
  });
  await run.begin();
  return run;
}

const click = (run: RunSession, name: string) =>
  run.perform({ kind: 'click', target: { role: 'link', name } });

const kindOf = async (p: Promise<unknown>): Promise<string | undefined> => {
  try {
    await p;
  } catch (e) {
    return e instanceof Error && 'kind' in e ? String(e.kind) : String(e);
  }
  return undefined;
};

const networkLog = (r: RunResult): unknown[] =>
  JSON.parse(readFileSync(join(r.evidence.dir, 'network.json'), 'utf8'));

const API = (path: string, init: RequestInit = {}) =>
  fetch(`${fixture.url}${path}`, {
    ...init,
    headers: { cookie: 'role=employee', 'content-type': 'application/json' },
  });

describe('downloads in a run', () => {
  it.each([
    ['a navigation answered with an attachment', 'Xuất báo cáo'],
    ['a download link', 'Tải báo cáo'],
  ])(
    'cancels %s in scope: nothing is saved, the run passes, network.json notes it',
    async (_what, name) => {
      const run = await open();
      const download = run.page.waitForEvent('download');
      await click(run, name);
      await expect((await download).path()).rejects.toThrow();
      expect((await run.check()).passed).toBe(true);
      const result = await run.finish({ status: 'passed' }, 0);
      expect(result.status).toBe('passed');
      expect(networkLog(result)).toContainEqual(
        expect.objectContaining({
          method: 'DOWNLOAD',
          url: `${fixture.url}${GUARD_PAGES.file}`,
          status: 0,
          note: 'download_cancelled',
        }),
      );
    },
  );

  it('keeps the cancelled download out of network assertions (fetch/xhr only, ADR 0010)', async () => {
    const run = await open({}, [
      { network: { method: 'DOWNLOAD', url: '**/report.csv', absent: true } },
    ]);
    const download = run.page.waitForEvent('download');
    await click(run, 'Tải báo cáo');
    await download;
    expect((await run.check(0)).passed).toBe(true);
    await run.finish({ status: 'passed' }, 0);
  });

  it('notes a download the page builds itself (data:) without failing the run, and without its content', async () => {
    const run = await open();
    const download = run.page.waitForEvent('download');
    await click(run, 'Tải bản nháp');
    await expect((await download).path()).rejects.toThrow();
    const result = await run.finish({ status: 'passed' }, 0);
    expect(result.status).toBe('passed');
    expect(networkLog(result)).toContainEqual(
      expect.objectContaining({
        method: 'DOWNLOAD',
        url: 'data:…',
        note: 'download_cancelled',
      }),
    );
  });

  it('refuses a download link to another origin before it is sent: scope_violation', async () => {
    const run = await open();
    expect(await kindOf(click(run, 'Tải từ nơi khác'))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
  });

  it('stops a download link to a denied path on the env origin before it is sent (the route alone never sees it)', async () => {
    await API('/api/__reset', { method: 'POST' });
    await API('/api/requests', {
      method: 'POST',
      body: JSON.stringify({ reason: 'giữ lại', type: 'LEAVE', amount: 1 }),
    });
    const run = await open({ target: { scope: { deny: ['/map/purge'] } } });
    await run.page.evaluate(`document.body.append(Object.assign(
      document.createElement('a'), { href: '/map/purge', download: '', textContent: 'Tải và xoá' }))`);
    await click(run, 'Tải và xoá').catch(() => undefined);
    await expect.poll(() => kindOf(run.check(0))).toBe('scope_violation');
    await run.finish({ status: 'passed' }, 0);
    const list = (await (await API('/api/requests')).json()) as {
      items: unknown[];
    };
    expect(list.items).toHaveLength(1);
  });
});
