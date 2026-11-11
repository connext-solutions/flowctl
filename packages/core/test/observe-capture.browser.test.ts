import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storageStatePath } from '../src/config.js';
import { observe, type AppMap } from '../src/observe/index.js';
import { fixtureConfig, seedProfiles } from './helpers.js';

/**
 * Calls and console errors grouped per crawled page (T2.3), with the redaction rules of run evidence (ADR 0030):
 * paths only, credential-looking values `***`, no bodies.
 */
let browser: Browser;
let leaky: Server;
let leakyUrl = '';

const listen = (s: Server): Promise<string> =>
  new Promise((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`);
    }),
  );

beforeAll(async () => {
  browser = await chromium.launch();
  leaky = createServer((req, res) => {
    if (req.url?.startsWith('/api/') === true) {
      res.writeHead(401, { 'content-type': 'application/json' });
      return res.end('{"token":"s3cr3t-body"}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>Lộ</title></head><body><h1>Lộ</h1><script>
console.error('login failed: password=hunter2 {"apiKey":"k-123"}');
fetch('/api/me?token=q-456').catch(() => {});
</script></body></html>`);
  });
  leakyUrl = await listen(leaky);
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => leaky.close(r));
});

const page = (m: AppMap, path: string) => {
  const found = m.pages.find((p) => p.path === path);
  if (found === undefined) throw new Error(`no page ${path}`);
  return found;
};

async function crawlFixture(fixture: Fixture): Promise<AppMap> {
  const cfg = fixtureConfig(fixture.url, {
    target: { scope: { deny: ['/admin/**'] } },
  });
  await seedProfiles(cfg, fixture.url);
  return (await observe(cfg, { browser, start: '/map' })).map;
}

describe('observe capture (T2.3)', () => {
  it('puts each fetch/xhr call and console error on the page it came from', async () => {
    const fixture = await startFixture('pageConsoleError');
    try {
      const map = await crawlFixture(fixture);
      expect(page(map, '/map/report').consoleErrors).toEqual([
        'seeded bug: report failed to render',
      ]);
      expect(page(map, '/requests').calls).toEqual([
        { method: 'GET', path: '/api/requests', status: 200 },
      ]);
      for (const p of ['/map', '/map/help', '/requests'])
        expect(page(map, p).consoleErrors, p).toEqual([]);
      expect(page(map, '/map').calls).toEqual([]);
    } finally {
      await fixture.close();
    }
  });

  it('keeps the document status of a page that fails', async () => {
    const fixture = await startFixture('page500');
    try {
      expect(page(await crawlFixture(fixture), '/map/report').status).toBe(500);
    } finally {
      await fixture.close();
    }
  });

  it('masks credential-looking text and keeps no query or body', async () => {
    const cfg = fixtureConfig(leakyUrl);
    const state = storageStatePath(cfg, 'local', 'employee');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const { map } = await observe(cfg, { browser });
    const home = page(map, '/');
    expect(home.calls).toEqual([
      { method: 'GET', path: '/api/me', status: 401 },
    ]);
    expect(home.consoleErrors).toEqual([
      'Failed to load resource: the server responded with a status of 401 (Unauthorized)',
      'login failed: password=*** {"apiKey":"***"}',
    ]);
    const text = JSON.stringify(map);
    for (const secret of ['hunter2', 'k-123', 'q-456', 's3cr3t-body'])
      expect(text).not.toContain(secret);
  });
});
