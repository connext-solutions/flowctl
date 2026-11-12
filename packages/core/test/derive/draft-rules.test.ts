import { describe, expect, it } from 'vitest';
import { lintSteps, type VerbRules } from '../../src/derive/index.js';
import { appMap, operation, page } from './build.js';
import { draft, draftWith, map, rows, VI } from './draft-fixture.js';

describe('draftCase rules (T4.2)', () => {
  it('finds no verb inside a quoted label', () => {
    const vi = appMap([
      page('/requests', 'Đơn từ', ['button:Chọn tất cả', 'button:Gửi']),
    ]);
    const d = draft(
      operation({
        id: 'all',
        headings: ['Đơn từ'],
        steps: ['Bấm "Chọn tất cả".'],
      }),
      vi,
      'staff',
    );
    expect(d.gaps).toEqual([]);
    expect(rows(d)).toEqual([['click', 'button', 'Chọn tất cả', null]]);

    const en = appMap([
      page('/requests', 'Requests', [
        'button:Go to settings',
        'button:Open',
        'button:See details',
      ]),
      page('/settings', 'Settings'),
    ]);
    for (const label of ['Go to settings', 'Open', 'See details']) {
      const op = operation({
        id: 'en-quote',
        title: 'Requests',
        headings: ['Requests'],
        steps: [`click "${label}"`],
      });
      const e = draftWith(op, en);
      expect(e.gaps).toEqual([]);
      expect(e.observed).toEqual([]);
      expect(rows(e)).toEqual([['click', 'button', label, null]]);
    }
  });

  it('makes a second quote of a fill or select a quoted_value gap, keeping its span', () => {
    const op = operation({
      id: 'values',
      headings: ['Đơn từ'],
      steps: [
        'Nhập "Lý do", "Số tiền".',
        'Chọn "Nhân viên" "An".',
        'Bấm "Gửi".',
      ],
    });
    const d = draft(op, map, 'staff');
    expect(rows(d)).toEqual([['click', 'button', 'Gửi', null]]);
    expect(d.gaps.map((g) => [g.step, g.reason, g.span?.text])).toEqual([
      [0, 'quoted_value', 'Số tiền'],
      [1, 'quoted_value', 'An'],
    ]);
    expect(JSON.stringify(d.steps)).not.toContain('"An"');
  });

  it('makes a negated action a negated gap, in English and in a caller table', () => {
    const m = appMap([
      page('/requests', 'Đơn từ', ['button:Gửi', 'button:Not now']),
    ]);
    const op = operation({
      id: 'neg',
      headings: ['Đơn từ'],
      steps: [
        'Do not click "Gửi".',
        'Don\'t click "Gửi".',
        'Never click "Gửi".',
        'Click "Gửi", then do not click "Gửi".',
        'Click "Not now".',
      ],
    });
    const d = draftWith(op, m);
    expect(d.gaps.map((g) => [g.step, g.reason, g.span?.text])).toEqual([
      [0, 'negated', 'Do not click "Gửi".'],
      [1, 'negated', 'Don\'t click "Gửi".'],
      [2, 'negated', 'Never click "Gửi".'],
      [3, 'negated', 'do not click "Gửi".'],
    ]);
    expect(rows(d)).toEqual([['click', 'button', 'Not now', null]]);

    const vi = draftWith(
      operation({
        id: 'neg-vi',
        headings: ['Đơn từ'],
        steps: ['Không bấm "Gửi".', 'Bấm "Gửi".'],
      }),
      m,
      { ...VI, negate: ['không'] },
    );
    expect(vi.gaps.map((g) => [g.step, g.reason])).toEqual([[0, 'negated']]);
    expect(rows(vi)).toEqual([['click', 'button', 'Gửi', null]]);
  });

  it('turns a select of a radio or an option into a click with no input', () => {
    const m = appMap([
      page(
        '/leave',
        'Nghỉ phép',
        ['button:Gửi'],
        ['radio:Cả ngày', 'option:Nửa ngày', 'combobox:Loại'],
      ),
    ]);
    const op = operation({
      id: 'pick',
      headings: ['Nghỉ phép'],
      steps: ['Chọn "Cả ngày".', 'Chọn "Nửa ngày".', 'Chọn "Loại".'],
    });
    const d = draft(op, m, 'staff');
    expect(d.gaps).toEqual([]);
    expect(rows(d)).toEqual([
      ['click', 'radio', 'Cả ngày', null],
      ['click', 'option', 'Nửa ngày', null],
      ['select', 'combobox', 'Loại', 'input-1'],
    ]);
    expect(lintSteps(d.steps, m)).toEqual([]);
  });

  it('opens a page whose title is quoted when the quote is no navigation label', () => {
    const m = appMap([
      ...map.pages,
      page('/settings', 'Cài đặt', ['button:Lưu cài đặt']),
    ]);
    const op = operation({
      id: 'title',
      title: 'Đơn từ',
      headings: ['Đơn từ'],
      steps: ['Mở trang "Cài đặt".', 'Bấm "Gửi".', 'Nhập "Lý do".'],
    });
    const d = draft(op, m, 'staff');
    expect(d.gaps).toEqual([]);
    expect(d.steps[0]).toMatchObject({ action: 'open', page: '/settings' });
    expect(d.steps[0]?.via).toBeUndefined();
  });

  it('refuses a malformed verb table with a ConfigError', () => {
    const op = operation({
      id: 'bad',
      headings: ['Đơn từ'],
      steps: ['Bấm "Gửi".'],
    });
    for (const bad of [
      { ...VI, click: 'bấm' },
      { ...VI, negate: [1] },
      { open: ['mở'] },
      { ...VI, observe: undefined },
    ])
      expect(() => draftWith(op, map, bad as unknown as VerbRules)).toThrow(
        /verb table/,
      );
  });

  it('plans a hostile step and a hostile spec in linear time', () => {
    const big = Array.from({ length: 20000 }, () => 'Bấm "Gửi"').join(', ');
    const many = Array.from({ length: 5000 }, () => 'Bấm "Gửi".');
    const t0 = performance.now();
    const one = draft(
      operation({ id: 'big', headings: ['Đơn từ'], steps: [big] }),
      map,
      'staff',
    );
    const lots = draft(
      operation({ id: 'many', headings: ['Đơn từ'], steps: many }),
      map,
      'staff',
    );
    expect(one.steps).toHaveLength(20000);
    expect(lots.steps).toHaveLength(5000);
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 30000);
});
