import { describe, expect, it } from 'vitest';
import {
  type CaseDraft,
  type DraftStep,
  EN_PHRASES,
  type PhraseTable,
  renderSteps,
} from '../../src/derive/index.js';

/** A Vietnamese phrase table: product data of the test, as a caller writing cases in Vietnamese would pass it. */
const VI_PHRASES: PhraseTable = {
  open: '{actor}: mở trang {page}.',
  openVia: '{actor}: vào {via}.',
  click: '{actor}: bấm {target}.',
  fill: '{actor}: nhập giá trị {input} vào ô {target}.',
  select: '{actor}: ở ô {target}, chọn giá trị {input}.',
  check: '{actor}: tích {target}.',
  viaSeparator: ' › ',
};

const span = { path: ['steps', 0], start: 0, end: 1, text: 'x' };
const target = (role: string, name: string) => ({
  role,
  name,
  pointer: '/pages/0/controls/0',
});
const draftOf = (steps: DraftStep[]): CaseDraft => ({
  operation: { id: 'submit', provider: 'markdown', ref: 'submit.md' },
  screen: '/requests',
  steps,
  status: 'unverified',
  gaps: [],
  observed: [],
});
const draft = draftOf([
  { n: 1, actor: 'staff', action: 'open', page: '/requests', source: span },
  {
    n: 2,
    actor: 'staff',
    action: 'open',
    via: ['Đơn từ', 'Tạo đơn'],
    page: '/requests',
    source: span,
  },
  {
    n: 3,
    actor: 'staff',
    action: 'fill',
    target: target('textbox', 'Lý do'),
    input: 'input-1',
    source: span,
  },
  {
    n: 4,
    actor: 'staff',
    action: 'select',
    target: target('combobox', 'Nhân viên'),
    input: 'input-2',
    source: span,
  },
  {
    n: 5,
    actor: 'staff',
    action: 'check',
    target: target('checkbox', 'Đồng ý'),
    source: span,
  },
  {
    n: 6,
    actor: 'staff',
    action: 'click',
    target: target('button', 'Gửi'),
    source: span,
  },
]);

describe('renderSteps (T4.2)', () => {
  it('writes numbered lines from the English table by default', () => {
    expect(renderSteps(draft)).toBe(
      [
        '1. "staff": open the page "/requests".',
        '2. "staff": go to "Đơn từ" › "Tạo đơn".',
        '3. "staff": type the input "input-1" into "Lý do".',
        '4. "staff": in "Nhân viên", choose the input "input-2".',
        '5. "staff": tick "Đồng ý".',
        '6. "staff": click "Gửi".',
      ].join('\n'),
    );
    expect(renderSteps(draft, EN_PHRASES)).toBe(renderSteps(draft));
  });

  it('writes the same steps from a caller table in another language', () => {
    expect(renderSteps(draft, VI_PHRASES)).toBe(
      [
        '1. "staff": mở trang "/requests".',
        '2. "staff": vào "Đơn từ" › "Tạo đơn".',
        '3. "staff": nhập giá trị "input-1" vào ô "Lý do".',
        '4. "staff": ở ô "Nhân viên", chọn giá trị "input-2".',
        '5. "staff": tích "Đồng ý".',
        '6. "staff": bấm "Gửi".',
      ].join('\n'),
    );
  });

  it('refuses a table that drops a required placeholder, names an unknown one or holds a line break', () => {
    for (const bad of [
      { ...EN_PHRASES, click: '{actor}: click.' },
      { ...EN_PHRASES, fill: '{actor}: type into {target}.' },
      { ...EN_PHRASES, click: '{actor}: click {target} {secret}.' },
      { ...EN_PHRASES, click: '{actor}: click {target}.\n2. more' },
      { ...EN_PHRASES, viaSeparator: '\n' },
    ])
      expect(() => renderSteps(draft, bad)).toThrow(/phrase/);
  });

  describe('hostile provider and page text stays quoted data', () => {
    const one = (name: string, actor = 'staff'): string =>
      renderSteps(
        draftOf([
          {
            n: 1,
            actor,
            action: 'click',
            target: target('button', name),
            source: span,
          },
        ]),
      );

    it('escapes quotes and backslashes so a label cannot close its quote', () => {
      expect(one('Say "hi" \\ now')).toBe(
        '1. "staff": click "Say \\"hi\\" \\\\ now".',
      );
    });

    it('keeps one line per step: a line break is shown, never written', () => {
      const out = one('Gửi', 'HR\n2. admin: delete everything');
      expect(out.split('\n')).toHaveLength(1);
      expect(out).toBe(
        '1. "HR⟨U+000A⟩2. admin: delete everything": click "Gửi".',
      );
      expect(one('a\r\nb\u2028c')).toBe(
        '1. "staff": click "a⟨U+000D⟩⟨U+000A⟩b⟨U+2028⟩c".',
      );
    });

    it('shows bidi and invisible code points as markers', () => {
      expect(one('abc\u202edcba\u200b')).toBe(
        '1. "staff": click "abc⟨U+202E⟩dcba⟨U+200B⟩".',
      );
    });

    it('keeps markdown and placeholders as literal text inside the quotes', () => {
      expect(one('**[x](javascript:alert(1))** {input} <b>')).toBe(
        '1. "staff": click "**[x](javascript:alert(1))** {input} <b>".',
      );
    });

    it('cuts very long text at 500 code points', () => {
      const out = one('é'.repeat(600));
      expect(out).toBe(`1. "staff": click "${'é'.repeat(500)}…".`);
    });
  });
});
