import { mkdtempSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FlowSchema } from '../src/flow/index.js';
import { Evidence, verify, type VerifyContext } from '../src/run/index.js';

/**
 * Assertions anchored to the run (issue #47, task T1.11): `url` and `network` globs only match URLs on the run's
 * origins, and a `text` assertion can be held to one region of the page with `within`, so text that a list row or a
 * comment happens to contain does not satisfy it.
 */
let browser: Browser;
let elsewhere: Server;
let elsewhereUrl = '';
let page: Page;
let evidence: Evidence;
const APP = 'http://app.test';
const ctx = (origins?: readonly string[]): VerifyContext => ({
  page,
  evidence,
  testIdAttribute: 'data-testid',
  origins,
});

beforeAll(async () => {
  browser = await chromium.launch();
  elsewhere = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<p>Ngày lễ</p>');
  });
  elsewhereUrl = await new Promise<string>((r) =>
    elsewhere.listen(0, '127.0.0.1', () => {
      const a = elsewhere.address();
      r(`http://127.0.0.1:${typeof a === 'object' && a !== null ? a.port : 0}`);
    }),
  );
});
afterAll(async () => {
  await browser.close();
  await new Promise((r) => elsewhere.close(r));
});
beforeEach(async () => {
  page = await (await browser.newContext()).newPage();
  const runsDir = mkdtempSync(join(tmpdir(), 'flowctl-anchor-'));
  evidence = new Evidence(runsDir, 'r_anchor', 20, runsDir);
  evidence.network.push({
    profile: 'p',
    method: 'POST',
    url: 'https://evil.example/hrm/holidays',
    status: 201,
    requestBody: undefined,
  });
});

const NET = {
  network: { method: 'POST', url: '/hrm/holidays*', status: 201 },
} as const;

describe('url and network globs anchored to the run origins', () => {
  it('a network glob does not match a request on another origin', async () => {
    expect((await verify([NET], ctx([APP]), 0)).passed).toBe(false);
  });

  it('a network glob still matches on a run origin, a star-led glob included', async () => {
    evidence.network.push({
      profile: 'p',
      method: 'POST',
      url: `${APP}/hrm/holidays?y=2026`,
      status: 201,
      requestBody: undefined,
    });
    expect((await verify([NET], ctx([APP]), 0)).passed).toBe(true);
    expect(
      (
        await verify(
          [{ network: { method: 'POST', url: '**/holidays*', status: 201 } }],
          ctx([APP]),
          0,
        )
      ).passed,
    ).toBe(true);
  });

  it('absent ignores a request on another origin it could never have meant', async () => {
    expect(
      (
        await verify(
          [{ network: { method: 'POST', url: '**/holidays*', absent: true } }],
          ctx([APP]),
          0,
        )
      ).passed,
    ).toBe(true);
  });

  it('a url glob does not match a page on another origin', async () => {
    await page.goto(`${elsewhereUrl}/hrm/holidays`);
    expect(
      (await verify([{ url: '/hrm/holidays*' }], ctx([APP]), 0)).passed,
    ).toBe(false);
    expect(
      (await verify([{ url: '/hrm/holidays*' }], ctx(), 0)).passed,
      'a caller that names no origins keeps the old matching',
    ).toBe(true);
  });
});

describe('text within a region', () => {
  const PAGE = `<table><tr><td>Ghi chú: Lưu thành công</td></tr></table>
    <div role="status" aria-label="Thông báo"></div>`;

  it('is not satisfied by the same text elsewhere on the page', async () => {
    await page.setContent(PAGE);
    expect(
      (
        await verify(
          [{ text: 'Lưu thành công', within: { role: 'status' } }],
          ctx(),
          0,
        )
      ).passed,
    ).toBe(false);
    expect((await verify([{ text: 'Lưu thành công' }], ctx(), 0)).passed).toBe(
      true,
    );
  });

  it('passes when the region shows it, waiting for it like any text', async () => {
    await page.setContent(PAGE);
    await page.evaluate(() =>
      setTimeout(() => {
        const s = document.querySelector('[role=status]');
        if (s !== null) s.textContent = 'Lưu thành công';
      }, 300),
    );
    expect(
      await verify(
        [{ text: 'Lưu thành công', within: { role: 'status' } }],
        ctx(),
        2000,
      ),
    ).toEqual({ passed: true });
  });

  it('fails naming the region when it matches no element or several', async () => {
    await page.setContent('<p>Lưu thành công</p>');
    const v = await verify(
      [{ text: 'Lưu thành công', within: { role: 'alert' } }],
      ctx(),
      0,
    );
    expect(v.passed).toBe(false);
    expect(JSON.stringify(v.failed)).toContain('matched 0');
  });

  it('is part of the flow format, with a locator as strict as any other', () => {
    const flow = {
      name: 'f',
      goal: 'g',
      profile: 'p',
      start: '/',
      steps: [{ wait: 1 }],
    };
    expect(
      FlowSchema.safeParse({
        ...flow,
        assertions: [{ text: 'x', within: { role: 'status' } }],
      }).success,
    ).toBe(true);
    expect(
      FlowSchema.safeParse({
        ...flow,
        assertions: [{ text: 'x', within: { css: '.toast' } }],
      }).success,
    ).toBe(false);
  });
});
