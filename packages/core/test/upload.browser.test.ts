import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { perform } from '../src/browser/index.js';
import { FlowError } from '../src/flow/index.js';

/** Upload steps read only from `fixtures/` in the flows directory, as bytes (ADR 0024 section 1a, issue #45). */
const o = {
  testIdAttribute: 'data-testid',
  timeout: 1500,
  flowsRoot: process.cwd(),
};
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await (await browser.newContext()).newPage();
});

describe('perform: upload', () => {
  it('uploads a file from fixtures/ of the flows directory, as bytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-up-'));
    mkdirSync(join(dir, 'fixtures', 'docs'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', 'docs', 'cv.pdf'), 'pdf');
    await page.setContent('<input type="file" data-testid="file">');
    await perform(
      page,
      {
        kind: 'upload',
        target: { testId: 'file' },
        file: 'fixtures/docs/cv.pdf',
      },
      {},
      { ...o, flowsRoot: dir },
    );
    expect(
      await page
        .locator('input')
        .evaluate((e) =>
          e instanceof HTMLInputElement
            ? `${e.files?.[0]?.name} ${e.files?.[0]?.type} ${e.files?.[0]?.size}`
            : undefined,
        ),
    ).toBe('cv.pdf application/pdf 3');
  });

  it('refuses an upload outside fixtures/, a dot-name, a symlink and a hard link (ADR 0024 section 1a, #45)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-up-'));
    const outside = mkdtempSync(join(tmpdir(), 'flowctl-out-'));
    writeFileSync(join(outside, 'secret.txt'), 'x');
    mkdirSync(join(dir, 'fixtures', '.GIT'), { recursive: true });
    writeFileSync(join(dir, 'fixtures', '.env'), 'x');
    writeFileSync(join(dir, 'fixtures', '.GIT', 'config'), 'x');
    writeFileSync(join(dir, 'notes.txt'), 'x');
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'fixtures', 'link.txt'));
    symlinkSync(outside, join(dir, 'fixtures', 'linked'));
    linkSync(join(outside, 'secret.txt'), join(dir, 'fixtures', 'hard.txt'));
    await page.setContent('<input type="file" data-testid="file">');
    for (const file of [
      join(outside, 'secret.txt'),
      '../../etc/passwd',
      'fixtures/../notes.txt',
      'notes.txt',
      'fixtures/.env',
      'fixtures/.GIT/config',
      'fixtures/link.txt',
      'fixtures/linked/secret.txt',
      'fixtures/hard.txt',
    ]) {
      const err: unknown = await perform(
        page,
        { kind: 'upload', target: { testId: 'file' }, file },
        {},
        { ...o, flowsRoot: dir },
      ).catch((e: unknown) => e);
      expect(err, file).toBeInstanceOf(FlowError);
      expect(String(err), file).toContain('path_not_contained');
      expect(String(err), file).not.toContain('x\n');
    }
  });
});
