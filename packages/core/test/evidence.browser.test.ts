import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Evidence } from '../src/run/index.js';
import { startFixture } from '@flowctl/fixture-app';

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function capture(bug: 'consoleError' | 'list500') {
  const f = await startFixture(bug);
  const runsDir = mkdtempSync(join(tmpdir(), 'flowctl-ev-'));
  const ev = new Evidence(runsDir, 'r_ev', 20, runsDir);
  const dir = ev.dir;
  const context = await browser.newContext({ baseURL: f.url });
  await context.addCookies([{ name: 'role', value: 'employee', url: f.url }]);
  await ev.attach(context, 'employee');
  const page = await context.newPage();
  await page.goto('/requests');
  await expect.poll(() => ev.network.length).toBeGreaterThan(0);
  const summary = await ev.collect([['employee', { context }]], page);
  await context.close();
  await f.close();
  return { ev, dir, summary };
}

describe('Evidence', () => {
  it('captures fetch/xhr and console errors from before the first navigation', async () => {
    const { ev, dir, summary } = await capture('consoleError');
    expect(
      ev.network.some(
        (e) =>
          e.method === 'GET' &&
          e.url.endsWith('/api/requests') &&
          e.status === 200,
      ),
    ).toBe(true);
    expect(ev.network.every((e) => e.url.includes('/api/'))).toBe(true);
    expect(summary.console.join(' ')).toContain('seeded bug');
    expect(summary.traces).toEqual([join(dir, 'trace-employee.zip')]);
    expect(existsSync(join(dir, 'trace-employee.zip'))).toBe(true);
    expect(existsSync(join(dir, 'final.png'))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(dir, 'network.json'), 'utf8')),
    ).toHaveLength(ev.network.length);
  });

  it('summarises failing api calls with a body snippet', async () => {
    const { summary } = await capture('list500');
    expect(summary.network).toEqual([
      expect.stringMatching(/^500 GET .*\/api\/requests \{"message":"boom"\}$/),
    ]);
  });

  it('logs a request once when its body read fails after the response (#30)', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/api/broken') {
        res.writeHead(500, { 'content-length': '100' });
        res.write('{"partial"');
        setTimeout(() => res.destroy(), 50);
        return;
      }
      res.end('<html><body>ok</body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const url = `http://127.0.0.1:${addr.port}`;
    const runsDir = mkdtempSync(join(tmpdir(), 'flowctl-ev-'));
    const ev = new Evidence(runsDir, 'r_dup', 20, runsDir);
    const context = await browser.newContext();
    try {
      await ev.attach(context, 'employee');
      const page = await context.newPage();
      await page.goto(url);
      const failed = page.waitForEvent('requestfailed');
      await page.evaluate(() =>
        fetch('/api/broken')
          .then((r) => r.text())
          .catch(() => ''),
      );
      await failed;
      await ev.settle();
      const hits = ev.network.filter((e) => e.url.endsWith('/api/broken'));
      expect(hits.map((e) => e.status)).toEqual([500]);
    } finally {
      await context.close();
      server.close();
    }
  });

  it('does not read an error body that declares more than MAX_RESPONSE_READ, and says so (#57)', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024);
    const server = createServer((req, res) => {
      if (req.url === '/api/huge') {
        res.writeHead(500, { 'content-length': String(big.length) });
        res.end(big);
        return;
      }
      if (req.url === '/api/small') {
        res.writeHead(500);
        res.end('{"error":"short"}');
        return;
      }
      res.end('<html><body>ok</body></html>');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const runsDir = mkdtempSync(join(tmpdir(), 'flowctl-ev-'));
    const ev = new Evidence(runsDir, 'r_big', 20, runsDir);
    const context = await browser.newContext();
    try {
      await ev.attach(context, 'employee');
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${addr.port}`);
      await page.evaluate(() =>
        Promise.all([
          fetch('/api/huge').then((r) => r.text()),
          fetch('/api/small').then((r) => r.text()),
        ]),
      );
      await ev.settle();
      const body = (path: string) =>
        ev.network.find((e) => e.url.endsWith(path))?.responseBody;
      expect(body('/api/huge')).toBe(
        `(body not read: content-length ${big.length})`,
      );
      expect(body('/api/small')).toBe('{"error":"short"}');
    } finally {
      await context.close();
      server.close();
    }
  });
});
