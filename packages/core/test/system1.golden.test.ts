import { expect, it } from 'vitest';
import type { PageSnapshot } from '../src/browser/index.js';
import { OPS, buildRequest } from '../src/system1/index.js';

const page: PageSnapshot = {
  url: 'http://app.test/o/org/hrm/settings/holidays',
  title: 'Quản lý ngày nghỉ',
  text: 'Quản lý ngày nghỉ\nThêm ngày nghỉ\nTên ngày nghỉ\nmat-khau-123',
  canScrollUp: false,
  canScrollDown: true,
  fingerprint: 'golden',
  controls: [
    {
      id: 1,
      role: 'button',
      name: 'Thêm ngày nghỉ',
      ops: ['CLICK'],
      value: '',
    },
    {
      id: 2,
      role: 'textbox',
      name: 'Tên ngày nghỉ*',
      ops: ['CLICK', 'TYPE_TEXT'],
      value: '',
    },
    {
      id: 3,
      role: 'combobox',
      name: '',
      ops: ['CLICK', 'SELECT'],
      value: 'Nghỉ lễ',
    },
    {
      id: 4,
      role: 'textbox',
      name: 'Mật khẩu xác nhận',
      ops: ['CLICK', 'TYPE_TEXT'],
      value: 'mat-khau-123',
    },
  ],
};

/**
 * The exact request flowctl sends to System 1 for a representative page, frozen in a file.
 *
 * @remarks Prompts and question wording steer a model we do not control. Any change to
 *   `system1/prompts.ts` or `protocol.ts` shows up here as a diff of `__golden__/system1-request.json`;
 *   update it with `bun run test -- -u packages/core/test/system1.golden.test.ts` only on purpose, and run
 *   the contract tier before merging (`.claude/rules/system1.md`).
 */
it('sends the frozen System 1 request', async () => {
  const { body, offered } = buildRequest(
    {
      goal: 'Thêm ngày nghỉ tên Flowctl {{uid}} loại Nghỉ sự kiện',
      page,
      history: [
        { op: 'CLICK', control: '[1] button "Thêm ngày nghỉ"', changed: true },
        {
          op: 'TYPE_TEXT',
          control: '[2] textbox "Tên ngày nghỉ*"',
          changed: false,
        },
      ],
      ops: [...OPS],
      inputs: [
        { key: 'holidayName', preview: 'Flowctl ab12' },
        { key: 'password' },
      ],
      secrets: ['mat-khau-123'],
    },
    'jev-latest',
  );
  expect(JSON.stringify(body)).not.toContain('mat-khau-123');
  await expect(
    `${JSON.stringify({ offered, body }, null, 2)}\n`,
  ).toMatchFileSnapshot('__golden__/system1-request.json');
});
