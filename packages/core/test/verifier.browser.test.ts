import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Evidence, MAX_CONSOLE_ERRORS, verify } from '../src/run/index.js';

let browser: Browser;
let page: Page;
let evidence: Evidence;
const ctx = () => ({ page, evidence, testIdAttribute: 'data-testid' });

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await (await browser.newContext()).newPage();
  const runsDir = mkdtempSync(join(tmpdir(), 'flowctl-ver-'));
  evidence = new Evidence(runsDir, 'r_ver', 20, runsDir);
  evidence.network.push(
    {
      profile: 'p',
      method: 'POST',
      url: 'http://h/api/requests',
      status: 201,
      requestBody: { type: 'LEAVE', amount: 2 },
    },
    {
      profile: 'p',
      method: 'PATCH',
      url: 'http://h/api/requests/7/approve?x=1',
      status: 403,
      requestBody: undefined,
    },
  );
});

describe('verify', () => {
  it('passes network assertions on method, url, status and request body', async () => {
    const v = await verify(
      [
        {
          network: {
            method: 'post',
            url: '/api/requests',
            status: 201,
            requestBody: { type: 'LEAVE' },
          },
        },
      ],
      ctx(),
      200,
    );
    expect(v).toEqual({ passed: true });
  });

  it('fails with what it actually saw', async () => {
    const v = await verify(
      [
        {
          network: {
            method: 'PATCH',
            url: '/api/requests/*/approve',
            status: 200,
          },
        },
      ],
      ctx(),
      200,
    );
    expect(v.passed).toBe(false);
    expect(v.failed?.got).toContain(
      '403 PATCH http://h/api/requests/7/approve?x=1',
    );
  });

  it('lists the method and path of every request it saw when none matches (H0.2)', async () => {
    const v = await verify(
      [{ network: { method: 'GET', url: '/api/roster', status: 200 } }],
      ctx(),
      0,
    );
    expect(v.failed?.got).toBe(
      'no matching fetch/xhr request; seen: PATCH /api/requests/7/approve, POST /api/requests',
    );
  });

  it('fails a request body that does not match', async () => {
    const v = await verify(
      [
        {
          network: {
            method: 'POST',
            url: '/api/requests',
            requestBody: { type: 'OT' },
          },
        },
      ],
      ctx(),
      200,
    );
    expect(v.passed).toBe(false);
  });

  it('refuses an assertion shape it does not know instead of reading it as another kind (#27)', async () => {
    await expect(
      verify(JSON.parse('[{"txt":"x"}]'), ctx(), 0),
    ).rejects.toMatchObject({ kind: 'internal' });
  });

  it('checks absent requests once, after the positive assertions', async () => {
    await page.setContent(
      '<p id="t"></p><script>setTimeout(() => { document.getElementById("t").textContent = "Xong"; }, 400)</script>',
    );
    const ok = await verify(
      [
        { network: { method: 'DELETE', url: '/api/requests', absent: true } },
        { text: 'Xong' },
      ],
      ctx(),
      3000,
    );
    expect(ok).toEqual({ passed: true });
    const bad = await verify(
      [{ network: { method: 'POST', url: '/api/requests', absent: true } }],
      ctx(),
      3000,
    );
    expect(bad.passed).toBe(false);
  });

  it('polls text until it appears, and fails when the timeout is too short', async () => {
    await page.setContent(
      '<p id="t"></p><script>setTimeout(() => { document.getElementById("t").textContent = "Đã duyệt"; }, 600)</script>',
    );
    expect((await verify([{ text: 'Đã duyệt' }], ctx(), 100)).passed).toBe(
      false,
    );
    expect((await verify([{ text: 'Đã duyệt' }], ctx(), 3000)).passed).toBe(
      true,
    );
  });

  it('is case-sensitive on text', async () => {
    await page.setContent('<p>VIỆC RIÊNG</p>');
    expect((await verify([{ text: 'Việc riêng' }], ctx(), 100)).passed).toBe(
      false,
    );
  });

  it('checks url, input value and console errors', async () => {
    await page.setContent('<label>Tên <input value="An"></label>');
    expect((await verify([{ url: 'about:blank' }], ctx(), 100)).passed).toBe(
      true,
    );
    expect(
      (
        await verify(
          [
            {
              value: {
                locator: { role: 'textbox', name: 'Tên' },
                equals: 'An',
              },
            },
          ],
          ctx(),
          100,
        )
      ).passed,
    ).toBe(true);
    expect((await verify([{ noConsoleErrors: true }], ctx(), 100)).passed).toBe(
      true,
    );
    evidence.consoleErrors.push('[p] boom');
    const v = await verify([{ noConsoleErrors: true }], ctx(), 100);
    expect(v).toEqual({
      passed: false,
      failed: { assertion: { noConsoleErrors: true }, got: '[p] boom' },
    });
    evidence.consoleErrors.length = 0;
    for (let i = 0; i < MAX_CONSOLE_ERRORS + 3; i++)
      evidence.noteConsoleError('p', `e${i}`);
    const dropped = await verify([{ noConsoleErrors: true }], ctx(), 100);
    const got = dropped.failed?.got ?? '';
    expect(dropped.passed).toBe(false);
    expect(got).toContain(
      `… and ${MAX_CONSOLE_ERRORS - 3} more in console.json`,
    );
    expect(got).toContain('… and 3 more not kept');
  });

  it('bounds the got of a network assertion with many matching requests (#57)', async () => {
    for (let i = 0; i < 40; i++)
      evidence.network.push({
        profile: 'p',
        method: 'GET',
        url: `http://h/api/poll?n=${i}`,
        status: 200,
        requestBody: { blob: 'z'.repeat(5000) },
      });
    const v = await verify(
      [{ network: { method: 'GET', url: '/api/poll', status: 201 } }],
      ctx(),
      100,
    );
    const got = v.failed?.got ?? '';
    expect(got.length).toBeLessThan(1100);
    expect(got).toContain('and 37 more');
  });

  it('reads the one visible field and refuses an ambiguous value locator (#25)', async () => {
    const name = { value: { locator: { testId: 'f' }, equals: 'An' } };
    await page.setContent(
      '<input data-testid="f" value="Bình" style="display:none"><input data-testid="f" value="An">',
    );
    expect((await verify([name], ctx(), 100)).passed).toBe(true);
    await page.setContent(
      '<input data-testid="f" value="An"><input data-testid="f" value="An">',
    );
    const v = await verify([name], ctx(), 100);
    expect(v.passed).toBe(false);
    expect(v.failed?.got).toMatch(/matched 2 elements/);
  });
});
