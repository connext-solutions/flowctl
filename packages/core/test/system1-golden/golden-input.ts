import type { PageSnapshot } from '../../src/browser/index.js';
import { OPS, type DecideInput } from '../../src/system1/index.js';

/** The representative page of the frozen System 1 request (`__golden__/system1-request.json`). */
export const goldenPage: PageSnapshot = {
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

/** The decision input whose request body is frozen in `__golden__/system1-request.json`. */
export const goldenInput: DecideInput = {
  goal: 'Thêm ngày nghỉ tên Flowctl {{uid}} loại Nghỉ sự kiện',
  page: goldenPage,
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
};
