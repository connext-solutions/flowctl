import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  StepError,
  markControl,
  recordLoc,
  takeSnapshot,
} from '../src/browser/index.js';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { openAs } from './helpers.js';

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

async function mark(page: Page, name: string): Promise<string> {
  const c = (await takeSnapshot(page)).controls.find((x) => x.name === name);
  if (c === undefined) throw new Error(`no control "${name}"`);
  const token = await markControl(page, c.id);
  if (token === undefined) throw new Error('mark failed');
  return token;
}

const record = async (page: Page, name: string, uid = 'zzzz') =>
  recordLoc(page, await mark(page, name), {
    testIdAttribute: 'data-testid',
    templated: [{ value: uid, template: '{{uid}}' }],
  });

describe('recordLoc', () => {
  it('records role and accessible name as Playwright computes them', async () => {
    const page = await openAs(browser, fixture.url, '/requests');
    expect(await record(page, 'Lý do')).toEqual({
      role: 'textbox',
      name: 'Lý do',
    });
    expect(await record(page, 'Nhân viên')).toEqual({
      role: 'combobox',
      name: 'Nhân viên',
    });
    expect(await record(page, 'Gửi')).toEqual({ role: 'button', name: 'Gửi' });
    await page.close();
  });

  it('prefers the test id', async () => {
    const page = await openAs(browser, fixture.url, '/lab');
    expect(await record(page, 'Lưu nháp')).toEqual({ testId: 'save-btn' });
    await page.close();
  });

  it('turns the run uid back into {{uid}}', async () => {
    const page = await openAs(browser, fixture.url, '/approvals');
    await page.request.post('/api/requests', {
      data: { reason: 'Việc riêng ab12cd34', type: 'LEAVE' },
    });
    await page.reload();
    await page
      .getByRole('button', { name: 'Duyệt Việc riêng ab12cd34' })
      .waitFor();
    expect(await record(page, 'Duyệt Việc riêng ab12cd34', 'ab12cd34')).toEqual(
      { role: 'button', name: 'Duyệt Việc riêng {{uid}}' },
    );
    await page.close();
  });

  it('reports an element that vanished before recording', async () => {
    const page = await openAs(browser, fixture.url, '/requests');
    const token = await mark(page, 'Gửi');
    await page.evaluate(
      "document.querySelector('[data-flowctl-target]').remove()",
    );
    await expect(
      recordLoc(page, token, { testIdAttribute: 'data-testid', templated: [] }),
    ).rejects.toBeInstanceOf(StepError);
    await page.close();
  });
});
