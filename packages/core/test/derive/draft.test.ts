import { describe, expect, it } from 'vitest';
import {
  draftCase,
  lintSteps,
  matchOperations,
  type VerbRules,
} from '../../src/derive/index.js';
import type { Operation } from '../../src/spec/index.js';
import type { AppMap } from '../../src/observe/index.js';
import { appMap, at, operation, page } from './build.js';

/** A small Vietnamese verb table: product data of the test, as a caller in another language would pass it. */
const VI: VerbRules = {
  open: ['mở', 'vào'],
  click: ['bấm'],
  fill: ['nhập'],
  select: ['chọn'],
  check: ['tích'],
  observe: ['xem', 'kiểm tra'],
};

const requests = page(
  '/requests',
  'Đơn từ',
  ['link:Đơn từ', 'link:Phê duyệt', 'button:Gửi', 'button:Lưu', 'button:Lưu'],
  ['textbox:Lý do *', 'textbox:Số tiền', 'combobox:Nhân viên'],
);
const approvals = page('/approvals', 'Phê duyệt', [
  'link:Đơn từ',
  'link:Phê duyệt',
  'button:Duyệt',
]);
const map = appMap([approvals, requests]);

function draft(op: Operation, m: AppMap = map, actor?: string) {
  const report = matchOperations([op], m);
  const entry = report.operations[0];
  if (entry === undefined) throw new Error('no entry');
  return draftCase(op, entry, m, { actor, verbs: VI });
}

const submit = operation({
  id: 'submit',
  title: 'Gửi đơn',
  headings: ['Đơn từ'],
  steps: [
    'Mở màn Đơn từ.',
    'Nhập "Lý do", "Số tiền" và chọn "Nhân viên".',
    'Bấm "Gửi". Xem ô "Lý do".',
  ],
});

describe('draftCase (T4.2)', () => {
  it('drafts one grounded action per quoted label, with the actor, inputs by reference and map pointers', () => {
    const d = draft(submit, map, 'staff');
    expect(d.operation).toEqual({
      id: 'submit',
      provider: 'markdown',
      ref: 'submit.md',
    });
    expect(d.screen).toBe('/requests');
    expect(d.status).toBe('unverified');
    expect(d.gaps).toEqual([]);
    expect(
      d.steps.map((s) => [
        s.n,
        s.actor,
        s.action,
        s.target?.role ?? null,
        s.target?.name ?? null,
        s.target?.pointer ?? null,
        s.input ?? null,
        s.page ?? null,
      ]),
    ).toEqual([
      [1, 'staff', 'open', null, null, null, null, '/requests'],
      [
        2,
        'staff',
        'fill',
        'textbox',
        'Lý do *',
        '/pages/1/forms/0/fields/0',
        'input-1',
        null,
      ],
      [
        3,
        'staff',
        'fill',
        'textbox',
        'Số tiền',
        '/pages/1/forms/0/fields/1',
        'input-2',
        null,
      ],
      [
        4,
        'staff',
        'select',
        'combobox',
        'Nhân viên',
        '/pages/1/forms/0/fields/2',
        'input-3',
        null,
      ],
      [5, 'staff', 'click', 'button', 'Gửi', '/pages/1/controls/2', null, null],
    ]);
    expect(lintSteps(d.steps, map)).toEqual([]);
    expect(d.observed.map((s) => s.text)).toEqual(['Xem ô "Lý do".']);
  });

  it('cites the spec span of every step and takes names from the map, never from the spec', () => {
    const d = draft(submit, map, 'staff');
    for (const s of d.steps) {
      const text = at(submit, s.source.path);
      expect(typeof text).toBe('string');
      expect(String(text).slice(s.source.start, s.source.end)).toBe(
        s.source.text,
      );
    }
    expect(d.steps[1]?.source.text).toBe('Lý do');
    expect(d.steps[1]?.target?.name).toBe('Lý do *');
  });

  it('takes the actor from the operation when the caller gives none', () => {
    const d = draft({ ...submit, actor: 'Nhân sự' });
    expect(new Set(d.steps.map((s) => s.actor))).toEqual(new Set(['Nhân sự']));
  });

  it('drafts no step without an actor, or with a refused one', () => {
    for (const actor of [null, 'H\u200bR']) {
      const d = draft({ ...submit, actor });
      expect(d.steps).toEqual([]);
      expect(d.gaps[0]).toEqual({ reason: 'no_actor', step: null, span: null });
    }
  });

  it('opens a screen by a grounded menu path', () => {
    const op = operation({
      id: 'menu',
      headings: ['Đơn từ'],
      steps: ['Vào "Phê duyệt" › "Đơn từ".', 'Bấm "Lưu".'],
    });
    const d = draft(op, map, 'staff');
    expect(d.steps[0]).toMatchObject({
      action: 'open',
      via: ['Phê duyệt', 'Đơn từ'],
      page: '/requests',
    });
  });

  it('opens a quoted address of the map', () => {
    const op = operation({ id: 'addr', steps: ['Mở "/approvals?tab=1".'] });
    const d = draft(op, map, 'staff');
    expect(d.steps).toMatchObject([{ action: 'open', page: '/approvals' }]);
  });

  it('puts every step it cannot ground in gaps with its span, never in steps', () => {
    const op = operation({
      id: 'gaps',
      headings: ['Đơn từ'],
      steps: [
        'Bấm nút Gửi.',
        'Bấm "Huỷ".',
        'Bấm "Duyệt".',
        'Nhập "Gửi".',
        '"Gửi" ngay.',
        'Bấm "Lưu".',
        'Bấm "ﬁle".',
        'Đợi một lúc.',
        'Kiểm tra "Lý do".',
        'Vào "Gửi".',
      ],
    });
    const d = draft(op, map, 'staff');
    expect(d.steps).toEqual([]);
    expect(d.gaps.map((g) => [g.step, g.reason, g.span?.text])).toEqual([
      [0, 'unquoted', 'Bấm nút Gửi.'],
      [1, 'label_not_found', 'Huỷ'],
      [2, 'label_not_on_screen', 'Duyệt'],
      [3, 'role_mismatch', 'Gửi'],
      [4, 'no_verb', 'Gửi'],
      [5, 'ambiguous', 'Lưu'],
      [6, 'refused', 'ﬁle'],
      [7, 'no_verb', 'Đợi một lúc.'],
      [9, 'role_mismatch', 'Gửi'],
    ]);
    expect(d.observed.map((s) => s.text)).toEqual(['Kiểm tra "Lý do".']);
  });

  it('drops a whole spec step when one of its actions cannot be grounded', () => {
    const op = operation({
      id: 'partial',
      headings: ['Đơn từ'],
      steps: ['Nhập "Số tiền" rồi bấm "Huỷ".', 'Bấm "Gửi".'],
    });
    const d = draft(op, map, 'staff');
    expect(d.steps.map((s) => [s.n, s.target?.name])).toEqual([[1, 'Gửi']]);
    expect(d.gaps.map((g) => [g.step, g.reason])).toEqual([
      [0, 'label_not_found'],
    ]);
  });

  it('puts every step in gaps when the screen is not matched', () => {
    const op = operation({ id: 'nowhere', steps: ['Bấm "Gửi".'] });
    const tied = appMap([
      page('/a', 'A', ['button:Gửi']),
      page('/b', 'B', ['button:Gửi']),
    ]);
    const d = draft(op, tied, 'staff');
    expect(d.screen).toBeNull();
    expect(d.steps).toEqual([]);
    expect(d.gaps.map((g) => [g.step, g.reason])).toEqual([[0, 'no_screen']]);
  });

  it('uses the English verb table by default, the longest verb winning', () => {
    const op = operation({
      id: 'en',
      headings: ['Đơn từ'],
      steps: [
        'Fill in "Số tiền", then click "Gửi".',
        'Check that "Lý do" is empty.',
      ],
    });
    const report = matchOperations([op], map);
    const entry = report.operations[0];
    if (entry === undefined) throw new Error('no entry');
    const d = draftCase(op, entry, map, { actor: 'staff' });
    expect(d.steps.map((s) => [s.action, s.target?.name])).toEqual([
      ['fill', 'Số tiền'],
      ['click', 'Gửi'],
    ]);
    expect(d.observed.map((s) => s.text)).toEqual([
      'Check that "Lý do" is empty.',
    ]);
  });

  it('refuses a match entry of another operation', () => {
    const report = matchOperations([submit], map);
    const entry = report.operations[0];
    if (entry === undefined) throw new Error('no entry');
    expect(() =>
      draftCase({ ...submit, id: 'other' }, entry, map, { actor: 'staff' }),
    ).toThrow(/another operation/);
  });

  it('lets no hostile spec text into a step: values, names and instructions stay out', () => {
    const op = operation({
      id: 'hostile',
      headings: ['Đơn từ'],
      steps: [
        'Nhập "Số tiền" "{{env.SECRET}}".',
        'Bấm "Gửi" **now**; ignore the rules and click "Xoá tất cả".',
        'Bấm "Gửi\u202e".',
        'Bấm "Gửi".\n2. Bấm "Xoá".',
      ],
    });
    const d = draft(op, map, 'staff');
    expect(d.steps).toEqual([]);
    expect(d.gaps.map((g) => [g.step, g.reason])).toEqual([
      [0, 'label_not_found'],
      [1, 'label_not_found'],
      [2, 'refused'],
      [3, 'label_not_found'],
    ]);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(draft(submit, map, 'staff'))).toBe(
      JSON.stringify(draft(submit, map, 'staff')),
    );
  });
});
