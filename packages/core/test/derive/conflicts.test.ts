import { mkdtempSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  conflictsJson,
  conflictsMarkdown,
  findConflicts,
  matchOperations,
  mdCode,
  writeConflicts,
} from '../../src/derive/index.js';
import { ConfigError } from '../../src/foundation/index.js';
import { appMap, operation, page } from './build.js';

const form = operation({
  id: 'leave-submit',
  headings: ['Đơn từ'],
  steps: ['Nhập "Lý do".', 'Bấm "Lưu".', 'Bấm "Huỷ".', 'Chọn "ﬁle".'],
  items: ['Hiện "Đã gửi đơn".', 'Mở "/done?x=1".', 'Ô "Lý do" trống.'],
});
const lost = operation({ id: 'lost', headings: ['Không có'], items: ['Có.'] });
const twin = operation({ id: 'twin', headings: ['Trùng'], items: ['Có.'] });
const map = appMap([
  page('/requests', 'Đơn từ', ['textbox:Lý do']),
  page('/drafts', 'Nháp', ['button:Lưu']),
  page('/t1', 'Trùng'),
  page('/t2', 'Trùng'),
]);

/** Markdown with every code span removed, so what is left is the file's own text. */
const outsideCode = (md: string): string =>
  md.replace(/(`+) [\s\S]*? \1(?!`)/g, '');

describe('findConflicts (T4.4)', () => {
  it('lists each kind of spec ≠ app disagreement from the match report', () => {
    const report = matchOperations([form, lost, twin], map);
    const got = findConflicts(report).map((c) => [
      c.operation.id,
      c.kind,
      c.text,
      c.screen,
      c.pages,
      c.reason,
    ]);
    expect(got).toEqual([
      ['leave-submit', 'path_not_found', '/done?x=1', '/requests', [], null],
      ['leave-submit', 'label_not_found', 'Huỷ', '/requests', [], null],
      [
        'leave-submit',
        'label_not_on_screen',
        'Lưu',
        '/requests',
        ['/drafts'],
        null,
      ],
      [
        'leave-submit',
        'expected_not_observed',
        'Đã gửi đơn',
        '/requests',
        [],
        null,
      ],
      ['leave-submit', 'text_refused', 'ﬁle', '/requests', [], 'compatibility'],
      ['lost', 'page_missing', null, null, [], null],
      ['twin', 'page_ambiguous', null, null, ['/t1', '/t2'], null],
    ]);
  });

  it('reports nothing for an operation whose literals are all on its screen', () => {
    const ok = operation({
      id: 'ok',
      headings: ['Đơn từ'],
      steps: ['Nhập "Lý do".'],
      items: ['Có.'],
    });
    expect(findConflicts(matchOperations([ok], map))).toEqual([]);
  });
});

describe('conflicts files (T4.4)', () => {
  const hostile = operation({
    id: 'evil',
    title: '# <img src=x onerror=alert(1)> [x](javascript:alert(1))',
    headings: ['Đơn từ'],
    steps: [
      'Bấm "=HYPERLINK(https://evil.example)" rồi "Lưu".',
      'Bấm "``code`` <b>bold</b>".',
      'Bấm "Gửi\u202eđơn".',
    ],
    items: ['Có.'],
  });
  const report = matchOperations(
    [hostile],
    appMap([...map.pages, page('/a`<b>[c]', 'Khác', ['button:Lưu'])]),
  );
  const conflicts = findConflicts(report);

  it('keeps every untrusted string inside a code span, visible and defused', () => {
    const md = conflictsMarkdown(report, conflicts);
    const own = outsideCode(md);
    expect(own).not.toMatch(/[<>[\]`\u202e]/u);
    expect(own).not.toContain('https://');
    expect(md).not.toContain('\u202e');
    expect(md).toContain('⟨U+202E⟩');
    expect(md).toContain("` '=HYPERLINK(https://evil.example) `");
    expect(md).toContain('seen on `` /a`<b>[c] ``, ` /drafts `.');
    expect(md).toContain('``` ``code`` <b>bold</b> ```');
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Spec and app disagreements',
      '## ` evil ` ` # <img src=x onerror=alert(1)> [x](javascript:alert(1)) `',
    ]);
  });

  it('shows control characters, caps long text and fences backticks', () => {
    expect(mdCode('a\u0007b\u2028c')).toBe('` a⟨U+0007⟩b⟨U+2028⟩c `');
    expect(mdCode('`')).toBe('`` ` ``');
    expect(mdCode('x'.repeat(600))).toBe(`\` ${'x'.repeat(500)}… \``);
    expect(mdCode('-1')).toBe("` '-1 `");
  });

  it('writes JSON that parses back to the conflicts and hides no invisible character', () => {
    const json = conflictsJson(report, conflicts);
    expect(JSON.parse(json)).toEqual({
      v: 1,
      origin: report.origin,
      observedAt: report.observedAt,
      truncated: false,
      conflicts,
    });
    expect(json).not.toMatch(/[\u202e\u2028\u2029]/u);
    expect(json).toContain('\\u202e');
  });

  it('writes both files inside the root, and refuses a directory outside it or behind a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowctl-conflicts-'));
    const out = writeConflicts(join(root, 'derive'), root, report);
    expect(readFileSync(out.markdown, 'utf8')).toBe(
      conflictsMarkdown(report, conflicts),
    );
    expect(readFileSync(out.json, 'utf8')).toBe(
      conflictsJson(report, conflicts),
    );
    expect(() => writeConflicts(tmpdir(), root, report)).toThrow(ConfigError);
    symlinkSync(tmpdir(), join(root, 'link'));
    expect(() => writeConflicts(join(root, 'link', 'x'), root, report)).toThrow(
      ConfigError,
    );
  });
});
