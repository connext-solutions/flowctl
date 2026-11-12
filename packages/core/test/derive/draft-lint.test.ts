import { describe, expect, it } from 'vitest';
import {
  type DraftStep,
  type LintStep,
  lintSteps,
} from '../../src/derive/index.js';
import { appMap, page } from './build.js';

const map = appMap([
  page(
    '/requests',
    'Đơn từ',
    ['link:Đơn từ', 'button:Gửi', 'button:Lưu'],
    ['textbox:Lý do', 'combobox:Nhân viên'],
  ),
]);
const span = { path: ['steps', 0], start: 0, end: 1, text: 'x' };
const click = (n: number, over: Partial<DraftStep> = {}): DraftStep => ({
  n,
  actor: 'staff',
  action: 'click',
  target: { role: 'button', name: 'Gửi', pointer: '/pages/0/controls/1' },
  source: span,
  ...over,
});
const fill = (n: number, over: Partial<DraftStep> = {}): DraftStep => ({
  n,
  actor: 'staff',
  action: 'fill',
  target: {
    role: 'textbox',
    name: 'Lý do',
    pointer: '/pages/0/forms/0/fields/0',
  },
  input: 'input-1',
  source: span,
  ...over,
});
const kinds = (steps: readonly LintStep[]) =>
  lintSteps(steps, map).map((p) => [p.step, p.kind]);

describe('lintSteps (T4.2)', () => {
  it('passes grounded, numbered steps', () => {
    const open: DraftStep = {
      n: 1,
      actor: 'staff',
      action: 'open',
      via: ['Đơn từ'],
      page: '/requests',
      source: span,
    };
    expect(kinds([open, fill(2), click(3)])).toEqual([]);
  });

  it('numbering: a step whose number is not its position', () => {
    expect(kinds([click(1), fill(3)])).toEqual([[1, 'numbering']]);
  });

  it('no_actor: an empty, blank or refused actor', () => {
    expect(
      kinds([
        click(1, { actor: '' }),
        fill(2, { actor: '  ' }),
        click(3, { actor: 'a\u202eb' }),
      ]),
    ).toEqual([
      [0, 'no_actor'],
      [1, 'no_actor'],
      [2, 'no_actor'],
    ]);
  });

  it('observe_only and unknown_action: a step that only looks, or does nothing known', () => {
    const look = { ...click(1), action: 'observe' };
    const odd = { ...click(2, { target: undefined }), action: 'wait' };
    expect(kinds([look, odd])).toEqual([
      [0, 'observe_only'],
      [1, 'unknown_action'],
    ]);
  });

  it('missing_target: an action with no quoted label, or an empty one', () => {
    expect(
      kinds([
        click(1, { target: undefined }),
        click(2, {
          target: { role: 'button', name: ' ', pointer: '/pages/0/controls/1' },
        }),
        { ...click(3, { target: undefined }), action: 'open' },
      ]),
    ).toEqual([
      [0, 'missing_target'],
      [1, 'missing_target'],
      [2, 'missing_target'],
    ]);
  });

  it('ungrounded_target: a label the map does not hold at its pointer', () => {
    expect(
      kinds([
        click(1, {
          target: {
            role: 'button',
            name: 'Huỷ',
            pointer: '/pages/0/controls/1',
          },
        }),
        click(2, {
          target: {
            role: 'button',
            name: 'Gửi',
            pointer: '/pages/9/controls/1',
          },
        }),
        click(3, {
          target: { role: 'link', name: 'Gửi', pointer: '/pages/0/controls/1' },
        }),
        click(4, {
          target: { role: 'button', name: 'Gửi', pointer: '/pages/0/x' },
        }),
      ]),
    ).toEqual([
      [0, 'ungrounded_target'],
      [1, 'ungrounded_target'],
      [2, 'ungrounded_target'],
      [3, 'ungrounded_target'],
    ]);
  });

  it('role_mismatch: an action its control cannot take', () => {
    expect(
      kinds([
        fill(1, {
          target: {
            role: 'button',
            name: 'Gửi',
            pointer: '/pages/0/controls/1',
          },
        }),
      ]),
    ).toEqual([[0, 'role_mismatch']]);
  });

  it('ungrounded_via and ungrounded_page: a menu label or a page the map does not hold', () => {
    const open = (n: number, via: string[], p?: string): DraftStep => ({
      n,
      actor: 'staff',
      action: 'open',
      via,
      page: p,
      source: span,
    });
    expect(
      kinds([open(1, ['Đơn từ', 'Gửi']), open(2, [], '/nowhere')]),
    ).toEqual([
      [0, 'ungrounded_via'],
      [1, 'ungrounded_page'],
    ]);
  });

  it('input_literal, missing_input, unexpected_input: inputs are references, only for fill and select', () => {
    expect(
      kinds([
        fill(1, { input: 'Nghỉ ốm 2 ngày' }),
        fill(2, { input: undefined }),
        click(3, { input: 'input-1' }),
        fill(4, { input: '{{uid}}' }),
      ]),
    ).toEqual([
      [0, 'input_literal'],
      [1, 'missing_input'],
      [2, 'unexpected_input'],
      [3, 'input_literal'],
    ]);
  });

  it('duplicate_step: the same action as the step before it', () => {
    expect(kinds([click(1), click(2), fill(3), click(4)])).toEqual([
      [1, 'duplicate_step'],
    ]);
  });
});
