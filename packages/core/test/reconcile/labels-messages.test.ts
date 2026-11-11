import { describe, expect, it } from 'vitest';
import {
  labelsInJson,
  localeFileOf,
  messagesInSource,
} from '../../src/reconcile/index.js';

describe('locale files', () => {
  it('recognises JSON files under a locale folder and names their locale', () => {
    expect(localeFileOf('src/i18n/vi.json')).toEqual({ locale: 'vi' });
    expect(localeFileOf('public/locales/en-US/common.json')).toEqual({
      locale: 'en-US',
    });
    expect(localeFileOf('messages/pt_BR.json')).toEqual({ locale: 'pt_BR' });
    expect(localeFileOf('src/translations/admin.json')).toEqual({
      locale: null,
    });
    expect(localeFileOf('package.json')).toBeUndefined();
    expect(localeFileOf('src/i18n/vi.ts')).toBeUndefined();
  });

  it('turns string leaves into labels with key, text and line', () => {
    const json = '{\n  "order": {\n    "submit": "Gửi đơn"\n  },\n  "n": 2\n}';
    expect(labelsInJson('src/i18n/vi.json', json)).toEqual([
      {
        file: 'src/i18n/vi.json',
        line: 3,
        key: 'order.submit',
        text: 'Gửi đơn',
        locale: 'vi',
      },
    ]);
    expect(labelsInJson('src/i18n/vi.json', '{oops')).toBeUndefined();
  });
});

describe('validator messages', () => {
  it('reads zod messages from calls and message properties', () => {
    const src = [
      "import { z } from 'zod';",
      'export const Order = z.object({',
      "  address: z.string({ required_error: 'Vui lòng nhập địa chỉ' })",
      "    .min(1, 'Vui lòng nhập địa chỉ')",
      '    .max(200, { message: "Địa chỉ tối đa 200 ký tự" }),',
      '  email: z.string().email(`Email không hợp lệ`),',
      '  code: z.string().regex(/^[A-Z]+$/, "Mã không hợp lệ"),',
      '  n: z.number().min(0),',
      '});',
    ].join('\n');
    expect(
      messagesInSource('src/order.ts', src).map((m) => [m.text, m.via, m.line]),
    ).toEqual([
      ['Vui lòng nhập địa chỉ', 'required_error:', 3],
      ['Vui lòng nhập địa chỉ', 'min()', 4],
      ['Địa chỉ tối đa 200 ký tự', 'message:', 5],
      ['Email không hợp lệ', 'email()', 6],
      ['Mã không hợp lệ', 'regex()', 7],
    ]);
  });

  it('reads yup and react-hook-form required messages', () => {
    const src = [
      "import * as yup from 'yup';",
      "import { useForm } from 'react-hook-form';",
      "const s = yup.object({ name: yup.string().required('Bắt buộc') });",
      "register('name', { required: 'Nhập tên', maxLength: { value: 5, message: 'Quá dài' } });",
      "yup.string().test('unique', 'Đã tồn tại', check);",
    ].join('\n');
    expect(messagesInSource('src/form.tsx', src).map((m) => m.text)).toEqual([
      'Bắt buộc',
      'Nhập tên',
      'Quá dài',
      'Đã tồn tại',
    ]);
  });

  it('reads nothing from a file that imports no validation library', () => {
    expect(
      messagesInSource(
        'src/x.ts',
        "toast({ message: 'Saved' }); s.min(1, 'a')",
      ),
    ).toEqual([]);
  });
});
