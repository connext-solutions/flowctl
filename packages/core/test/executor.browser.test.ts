import { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StepError, perform } from '../src/browser/index.js';
import { FlowError } from '../src/flow/index.js';
import { startFixture, type Fixture } from '@flowctl/fixture-app';

const o = {
  testIdAttribute: 'data-testid',
  timeout: 1500,
  flowsRoot: process.cwd(),
};
let browser: Browser;
let fixture: Fixture;
let context: BrowserContext;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
  fixture = await startFixture();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});
beforeEach(async () => {
  context = await browser.newContext({ baseURL: fixture.url });
  await context.addCookies([
    { name: 'role', value: 'employee', url: fixture.url },
  ]);
  page = await context.newPage();
});

describe('perform: locating', () => {
  it('ignores hidden copies when matching a locator (#25)', async () => {
    await page.setContent(
      '<button data-testid="x" style="display:none">A</button><button data-testid="x" onclick="this.textContent=\'done\'">B</button>',
    );
    await perform(page, { kind: 'click', target: { testId: 'x' } }, {}, o);
    await expect
      .poll(() => page.locator('button').nth(1).textContent())
      .toBe('done');
  });

  it('turns a page that closes after the action into a step failure, not an internal error (#26)', async () => {
    const own = await browser.newPage();
    await own.route('**/slow', () => {
      void own.close();
    });
    await own.setContent(
      '<button data-testid="bye" onclick="location.href=\'http://flowctl.test/slow\'">Bye</button>',
    );
    const err: unknown = await perform(
      own,
      { kind: 'click', target: { testId: 'bye' } },
      {},
      o,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err).toMatchObject({ kind: 'action_failed' });
  });

  it('clicks by role and exact name', async () => {
    await page.setContent(
      '<button onclick="this.textContent=\'done\'">Lưu</button><button>Lưu nháp</button>',
    );
    await perform(
      page,
      { kind: 'click', target: { role: 'button', name: 'Lưu' } },
      {},
      o,
    );
    await expect
      .poll(() => page.locator('button').first().textContent())
      .toBe('done');
  });

  it('fails as ambiguous when two elements match', async () => {
    await page.setContent('<button>Lưu</button><button>Lưu</button>');
    await expect(
      perform(
        page,
        { kind: 'click', target: { role: 'button', name: 'Lưu' } },
        {},
        o,
      ),
    ).rejects.toMatchObject({
      kind: 'ambiguous',
    });
  });

  it('fails as not_found when nothing matches', async () => {
    await page.setContent('<button>Khác</button>');
    const err = await perform(
      page,
      { kind: 'click', target: { role: 'button', name: 'Lưu' } },
      {},
      o,
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect(err).toMatchObject({ kind: 'not_found' });
  });

  it('honours the configured test id attribute', async () => {
    await page.setContent(
      '<button data-qa="save" onclick="this.textContent=\'ok\'">x</button>',
    );
    await perform(
      page,
      { kind: 'click', target: { testId: 'save' } },
      {},
      { ...o, testIdAttribute: 'data-qa' },
    );
    await expect.poll(() => page.locator('button').textContent()).toBe('ok');
  });

  it('reports a missing input value as action_failed', async () => {
    await page.setContent('<label>Tên <input></label>');
    await expect(
      perform(
        page,
        {
          kind: 'fill',
          target: { role: 'textbox', name: 'Tên' },
          input: 'name',
        },
        {},
        o,
      ),
    ).rejects.toMatchObject({ kind: 'action_failed' });
  });
});

describe('perform: anti-flaky strategies on the fixture', () => {
  it('a naive fill loses the first edit of the money field (the trap)', async () => {
    await page.goto('/requests');
    await page
      .getByRole('textbox', { name: 'Số tiền', exact: true })
      .fill('200000');
    await page.waitForTimeout(300);
    expect(
      await page
        .getByRole('textbox', { name: 'Số tiền', exact: true })
        .inputValue(),
    ).toBe('');
  });

  it('fill re-fills until the value sticks', async () => {
    await page.goto('/requests');
    await perform(
      page,
      {
        kind: 'fill',
        target: { role: 'textbox', name: 'Số tiền' },
        input: 'amount',
      },
      { amount: '200000' },
      o,
    );
    await expect
      .poll(() =>
        page
          .getByRole('textbox', { name: 'Số tiền', exact: true })
          .inputValue(),
      )
      .toBe('200.000');
  });

  it('types into a keyup-driven combobox so its options appear', async () => {
    await page.goto('/requests');
    await perform(
      page,
      {
        kind: 'fill',
        target: { role: 'combobox', name: 'Nhân viên' },
        input: 'q',
      },
      { q: 'Nguyễn' },
      o,
    );
    await perform(
      page,
      { kind: 'click', target: { role: 'option', name: 'Nguyễn Văn A' } },
      {},
      o,
    );
    expect(
      await page.getByRole('combobox', { name: 'Nhân viên' }).inputValue(),
    ).toBe('Nguyễn Văn A');
  });
});

describe('perform: select', () => {
  it('selects a native option by label', async () => {
    await page.setContent(
      '<label>Loại <select><option>Nghỉ lễ công</option><option>Nghỉ sự kiện</option></select></label>',
    );
    await perform(
      page,
      {
        kind: 'select',
        target: { role: 'combobox', name: 'Loại' },
        input: 't',
      },
      { t: 'Nghỉ sự kiện' },
      o,
    );
    expect(await page.locator('select').inputValue()).toBe('Nghỉ sự kiện');
  });

  it('opens a custom combobox and clicks the option (Radix-style)', async () => {
    await page.setContent(`
      <button role="combobox" aria-label="Loại" onclick="document.getElementById('lb').hidden=false">Nghỉ lễ công</button>
      <ul id="lb" role="listbox" hidden>
        <li role="option" onclick="document.querySelector('[role=combobox]').textContent=this.textContent">Nghỉ sự kiện</li>
      </ul>`);
    await perform(
      page,
      {
        kind: 'select',
        target: { role: 'combobox', name: 'Loại' },
        input: 't',
      },
      { t: 'Nghỉ sự kiện' },
      o,
    );
    expect(await page.getByRole('combobox').textContent()).toBe('Nghỉ sự kiện');
  });
});
