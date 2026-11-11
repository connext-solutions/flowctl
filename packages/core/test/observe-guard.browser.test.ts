import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { dirname } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { storageStatePath } from '../src/config.js';
import { observe } from '../src/observe/index.js';
import { fixtureConfig } from './helpers.js';

/**
 * The crawl's request layer (ADR 0024 section 5, ADR 0033) on a local env: a page that writes as soon as it loads
 * (a POST, a beacon) and calls another origin is still mapped, but no write and no call out of scope reaches a
 * server, and the page records what was refused.
 */
let browser: Browser;
let app: Server;
let outside: Server;
let appUrl = '';
let outsideUrl = '';
const seen: string[] = [];
let outsideHits = 0;
let upgrades = 0;

const listen = (s: Server): Promise<string> =>
  new Promise((r) =>
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      r(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`);
    }),
  );

const html = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"><title>${title}</title></head><body>${body}</body></html>`;

beforeAll(async () => {
  browser = await chromium.launch();
  outside = createServer((_req, res) => {
    outsideHits++;
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('{}');
  });
  outsideUrl = await listen(outside);
  app = createServer((req, res) => {
    seen.push(`${req.method ?? ''} ${req.url ?? ''}`);
    if (req.url === '/twice') {
      res.writeHead(302, { location: '/hop' });
      return res.end();
    }
    if (req.url === '/hop') {
      res.writeHead(302, { location: `${outsideUrl}/landing` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/writes')
      return res.end(
        html(
          'Ghi',
          `<h1>Ghi</h1><a href="/">Về</a><script>
fetch('/api/save', { method: 'POST', body: '{}' }).catch(() => {});
navigator.sendBeacon('/api/beacon', 'x');
fetch('${outsideUrl}/track').catch(() => {});
</script>`,
        ),
      );
    if (req.url === '/popup-chain')
      return res.end(
        html(
          'Cửa sổ',
          `<h1>Cửa sổ</h1><a href="/">Về</a><script>window.open('/twice')</script>`,
        ),
      );
    if (req.url === '/ws')
      return res.end(
        html(
          'Trực tiếp',
          `<h1>Trực tiếp</h1><script>new WebSocket('${appUrl.replace('http', 'ws')}/socket');</script>`,
        ),
      );
    if (req.url === '/busy' || req.url === '/busy2')
      return res.end(
        html(
          'Bận',
          `<h1>Bận</h1><a href="/busy2">Tiếp</a><script>setInterval(() => fetch('/ping').catch(() => {}), 100);</script>`,
        ),
      );
    if (req.url === '/spa')
      return res.end(
        html(
          'Ứng dụng',
          `<h1>Ứng dụng</h1><script>history.replaceState(null, '', '/admin/x');</script>`,
        ),
      );
    res.end(html('Trang chủ', '<h1>Trang chủ</h1><a href="/writes">Ghi</a>'));
  });
  app.on('upgrade', (_req, socket) => {
    upgrades++;
    socket.destroy();
  });
  appUrl = await listen(app);
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => app.close(r));
  await new Promise((r) => outside.close(r));
});

const crawlConfig = (extra: Record<string, unknown> = {}) => {
  const cfg = fixtureConfig(appUrl, extra);
  const state = storageStatePath(cfg, 'local', 'employee');
  mkdirSync(dirname(state), { recursive: true });
  writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
  return cfg;
};

describe('observe request layer', () => {
  it('maps a page that writes on load without sending the write or the call out of scope', async () => {
    const cfg = fixtureConfig(appUrl);
    const state = storageStatePath(cfg, 'local', 'employee');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const { map, run } = await observe(cfg, { browser });
    expect(run.status).toBe('passed');
    expect(map.pages.map((p) => [p.path, p.status])).toEqual([
      ['/', 200],
      ['/writes', 200],
    ]);
    expect(map.pages[1]?.refused).toEqual([
      'destructive_blocked',
      'scope_violation',
    ]);
    expect(map.pages[1]?.calls).toEqual([
      { method: 'POST', path: '/api/save', status: 0 },
      { method: 'GET', path: '/track', status: 0, origin: outsideUrl },
    ]);
    expect(seen.filter((s) => !s.startsWith('GET '))).toEqual([]);
    expect(outsideHits).toBe(0);
  });

  it('records a page that moves itself to a denied path (pushState) under the path it opened', async () => {
    const cfg = fixtureConfig(appUrl, {
      target: { scope: { deny: ['/admin/**'] } },
    });
    const state = storageStatePath(cfg, 'local', 'employee');
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ cookies: [], origins: [] }));
    const before = seen.length;
    const { map, run } = await observe(cfg, { browser, start: '/spa' });
    expect(run.status).toBe('passed');
    expect(map.pages.map((p) => [p.path, p.title])).toEqual([
      ['/spa', 'Ứng dụng'],
    ]);
    expect(seen.slice(before).some((s) => s.includes('/admin'))).toBe(false);
  });

  it('ends the crawl scope_violation on a hop it only detected after it was sent (the second hop of a popup chain)', async () => {
    const { run, map } = await observe(crawlConfig(), {
      browser,
      start: '/popup-chain',
    });
    expect(outsideHits).toBeGreaterThan(0);
    expect(run.status).toBe('error');
    expect(run.error?.kind).toBe('scope_violation');
    expect(run.error?.hint).toContain('/landing');
    expect(map.pages.map((p) => p.path)).toEqual(['/popup-chain']);
    expect(map.truncated).toBe(true);
  });

  it('closes every WebSocket in a crawl, even one in scope: a frame could carry a write', async () => {
    const before = upgrades;
    const { map, run } = await observe(crawlConfig(), {
      browser,
      start: '/ws',
    });
    expect(run.status).toBe('passed');
    expect(map.pages.map((p) => p.path)).toEqual(['/ws']);
    expect(upgrades - before).toBe(0);
  });

  it('caps the settle wait of a page whose network never goes quiet, well under stepTimeout', async () => {
    const { map, run } = await observe(crawlConfig({ stepTimeout: 10_000 }), {
      browser,
      start: '/busy',
    });
    expect(run.status).toBe('passed');
    expect(map.pages.map((p) => p.path)).toEqual(['/busy', '/busy2']);
    expect(run.ms).toBeLessThan(8_000);
  });
});
