import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameTexts } from '../src/browser/index.js';

/**
 * `frameTexts` reads the body text of every frame of a page through CDP (the run ledger's page-text scan, ADR 0030
 * amendment 2026-11-12): the main frame, a same-process frame and a cross-site frame in its own process (site
 * isolation on, as a caller's browser may have it), with page scripts that cannot change what it reads.
 */
let browser: Browser;
let server: Server;
let port = 0;
let page: Page;

const PAGES: Record<string, string> = {
  '/main': `<p>Trang chính</p><iframe srcdoc="<p>Khung cùng nguồn</p>"></iframe><iframe id="x"></iframe>
<script>
document.getElementById('x').src = 'http://127.0.0.1:' + location.port + '/inner';
Object.defineProperty(HTMLElement.prototype, 'innerText', { get: () => 'giả' });
</script>`,
  '/inner': '<p>Khung khác trang</p>',
};

beforeAll(async () => {
  server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      `<!doctype html><meta charset="utf-8">${PAGES[req.url ?? ''] ?? ''}`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('no port');
  port = (address satisfies AddressInfo).port;
  browser = await chromium.launch({ args: ['--site-per-process'] });
  page = await browser.newPage();
  await page.goto(`http://localhost:${port}/main`);
  await page.frameLocator('#x').locator('p').waitFor();
});
afterAll(async () => {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
});

describe('frameTexts', () => {
  it('reads the main frame, a same-process frame and a cross-site frame, past a page script that fakes innerText', async () => {
    const cross = page.frames().find((f) => f.url().includes('/inner'));
    expect(cross).toBeDefined();
    if (cross !== undefined)
      await page
        .context()
        .newCDPSession(cross)
        .then((s) => s.detach());
    const texts = await frameTexts(page);
    expect(texts).toEqual(
      expect.arrayContaining([
        'Trang chính',
        'Khung cùng nguồn',
        'Khung khác trang',
      ]),
    );
    expect(texts).not.toContain('giả');
  });

  it('reads again on the same page, and gives nothing for a closed page', async () => {
    expect(await frameTexts(page)).toContain('Trang chính');
    const other = await browser.newPage();
    await other.setContent('<p>Đóng</p>');
    expect(await frameTexts(other)).toEqual(['Đóng']);
    await other.close();
    expect(await frameTexts(other)).toEqual([]);
  });
});
