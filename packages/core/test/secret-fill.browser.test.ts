import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { perform } from '../src/browser/index.js';
import { FlowError } from '../src/flow/index.js';

/** Typing a secret input (ADR 0030): through CDP, checked without reading the value back, never selected. */
const o = {
  testIdAttribute: 'data-testid',
  timeout: 1500,
  flowsRoot: process.cwd(),
};
let browser: Browser;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  context = await browser.newContext();
  page = await context.newPage();
});

describe('perform: secret inputs (ADR 0030)', () => {
  const secret = { ...o, secrets: ['s3cr3t-value'] };

  it('types a secret into a content-editable field and checks it without reading it back', async () => {
    await page.setContent(
      '<label for="c">Ghi chú</label><div id="c" role="textbox" aria-label="Ghi chú" contenteditable="true"></div>',
    );
    await perform(
      page,
      {
        kind: 'fill',
        target: { role: 'textbox', name: 'Ghi chú' },
        input: 'n',
      },
      { n: 's3cr3t-value' },
      secret,
    );
    expect(await page.locator('#c').textContent()).toBe('s3cr3t-value');
  });

  it('accepts a field that moves focus on once it is filled', async () => {
    await page.setContent(
      '<input aria-label="Mã" oninput="this.value && document.getElementById(\'next\').focus()"><input id="next" aria-label="Tiếp">',
    );
    await perform(
      page,
      { kind: 'fill', target: { role: 'textbox', name: 'Mã' }, input: 'n' },
      { n: 's3cr3t-value' },
      secret,
    );
    expect(await page.locator('input').first().inputValue()).toBe(
      's3cr3t-value',
    );
  });

  it('refuses to select a secret, as a fault of the flow', async () => {
    await page.setContent(
      '<label>Loại <select><option>s3cr3t-value</option></select></label>',
    );
    await expect(
      perform(
        page,
        {
          kind: 'select',
          target: { role: 'combobox', name: 'Loại' },
          input: 'n',
        },
        { n: 's3cr3t-value' },
        secret,
      ),
    ).rejects.toBeInstanceOf(FlowError);
  });
});
