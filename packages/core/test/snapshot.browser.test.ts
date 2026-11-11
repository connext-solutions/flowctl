import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  MARK_ATTRIBUTE,
  markControl,
  takeSnapshot,
  type PageSnapshot,
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

const find = (s: PageSnapshot, name: string) =>
  s.controls.find((c) => c.name === name);

describe('takeSnapshot', () => {
  it('lists visible controls with the operations they allow', async () => {
    const page = await openAs(browser, fixture.url, '/requests');
    const s = await takeSnapshot(page);
    expect(find(s, 'Lý do')).toMatchObject({
      role: 'textbox',
      ops: ['CLICK', 'TYPE_TEXT'],
    });
    expect(find(s, 'Nhân viên')).toMatchObject({
      role: 'combobox',
      ops: ['CLICK', 'TYPE_TEXT'],
    });
    expect(find(s, 'Gửi')).toMatchObject({ role: 'button', ops: ['CLICK'] });
    expect(s.text).toContain('Đơn từ');
    await page.close();
  });

  it('never lists password fields and leaves out ignored selectors', async () => {
    const page = await openAs(browser, fixture.url, '/lab');
    const s = await takeSnapshot(page);
    expect(s.controls.some((c) => c.name === 'Mật khẩu')).toBe(false);
    expect(find(s, 'Devtools')).toBeDefined();
    const ignored = await takeSnapshot(page, ['.devtools']);
    expect(find(ignored, 'Devtools')).toBeUndefined();
    expect(ignored.text).not.toContain('Devtools');
    await page.close();
  });

  it('always leaves out known dev overlays such as React Query Devtools', async () => {
    const page = await openAs(browser, fixture.url, '/lab');
    const s = await takeSnapshot(page);
    expect(s.controls.some((c) => c.name.includes('React Query'))).toBe(false);
    await page.close();
  });

  it('describes native selects with their options', async () => {
    const page = await openAs(browser, fixture.url, '/lab');
    expect(find(await takeSnapshot(page), 'Loại đơn')).toMatchObject({
      role: 'combobox',
      ops: ['SELECT'],
      value: 'Nghỉ phép',
      options: ['Nghỉ phép', 'Tăng ca'],
    });
    await page.close();
  });

  it('reports scrolling and leaves off-screen controls out', async () => {
    const page = await openAs(browser, fixture.url, '/lab');
    const s = await takeSnapshot(page);
    expect(s.canScrollDown).toBe(true);
    expect(s.canScrollUp).toBe(false);
    expect(find(s, 'Cuối trang')).toBeUndefined();
    await page.close();
  });

  it('keeps ids stable, changes the fingerprint and marks one element', async () => {
    const page = await openAs(browser, fixture.url, '/requests');
    const before = await takeSnapshot(page);
    const reason = find(before, 'Lý do');
    if (reason === undefined) throw new Error('no reason field');
    await page.getByRole('textbox', { name: 'Lý do' }).fill('x');
    const after = await takeSnapshot(page);
    expect(find(after, 'Lý do')?.id).toBe(reason.id);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    const token = await markControl(page, reason.id);
    expect(
      await page.locator(`[${MARK_ATTRIBUTE}="${token ?? ''}"]`).count(),
    ).toBe(1);
    expect(await markControl(page, 99_999)).toBeUndefined();
    await page.close();
  });

  it('waits for a page that renders its first control late', async () => {
    const page = await openAs(browser, fixture.url, '/slow');
    expect((await takeSnapshot(page)).controls).toEqual([]);
    await page.reload();
    const s = await takeSnapshot(page, [], 3000);
    expect(s.controls.map((c) => c.name)).toEqual(['Hiện muộn']);
    await page.close();
  });
});
