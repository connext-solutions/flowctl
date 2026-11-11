import { describe, expect, it } from 'vitest';
import {
  compareText,
  fold,
  normText,
  occurrences,
  quotedSpans,
  refusal,
} from '../../src/derive/index.js';

describe('matcher text rules (ADR 0034 on ADR 0020)', () => {
  it('normalises to NFC and collapses ASCII whitespace', () => {
    expect(normText('  Gu\u0300i\t\n  đơn ')).toBe('Gùi đơn');
    expect(normText('Gửi'.normalize('NFD'))).toBe('Gửi');
  });

  it('refuses compatibility forms, invisible characters and non-ASCII digits', () => {
    expect(refusal('ﬁle')).toBe('compatibility');
    expect(refusal('Ｇửi')).toBe('compatibility');
    expect(refusal('Gửi\u200b')).toBe('invisible');
    expect(refusal('Gửi\u202e')).toBe('invisible');
    expect(refusal('a\u0007b')).toBe('invisible');
    expect(refusal('mã ٣')).toBe('digit');
    expect(refusal('file 3 Gửi')).toBeNull();
  });

  it('folds case and a trailing required marker or colon, never anything else', () => {
    expect(fold('Tên ngày nghỉ *')).toBe('tên ngày nghỉ');
    expect(fold('Lý do:')).toBe('lý do');
    expect(fold('Gửi đơn')).toBe('gửi đơn');
    expect(compareText('Lý do', 'Lý do')).toBe('exact');
    expect(compareText('lý do', 'Lý do *')).toBe('folded');
    expect(compareText('Lý do', 'Lý')).toBeNull();
    expect(compareText('*', ':')).toBeNull();
    expect(compareText('', '')).toBeNull();
  });

  it('finds occurrences at token boundaries only (ADR 0020 amendment 2026-11-12, section 2)', () => {
    const at = (value: string, text: string): boolean =>
      occurrences(text, value).length === 1;
    expect(at('5', '5 items')).toBe(true);
    expect(at('5', '15 items')).toBe(false);
    expect(at('5', '1.5 kg')).toBe(false);
    expect(at('5', '5.5 kg')).toBe(false);
    expect(at('5', 'Total 5.')).toBe(true);
    expect(at('5', '5%')).toBe(true);
    expect(at('5', '-5')).toBe(false);
    expect(at('OK', 'BOOK')).toBe(false);
    expect(at('order-12', 'order-12-b')).toBe(false);
    expect(at('order-12', '(order-12)')).toBe(true);
    expect(occurrences('5 items and 5 more', '5')).toHaveLength(2);
  });

  it('matches case-insensitively, with UTF-16 offsets into the text and whether the case was exact', () => {
    const text = 'Các trang của sơ đồ 𝐀 Sơ đồ';
    const found = occurrences(text, 'Sơ đồ');
    expect(found.map((o) => text.slice(o.start, o.end))).toEqual([
      'sơ đồ',
      'Sơ đồ',
    ]);
    expect(found.map((o) => o.exact)).toEqual([false, true]);
    expect(occurrences('Đơn từng', 'Đơn từ')).toEqual([]);
  });

  it('lists quoted literals with the offsets of their inner text', () => {
    const text = 'Nhập "Lý do", “Số tiền” và chọn "Nhân viên".';
    const spans = quotedSpans(text);
    expect(spans.map((s) => s.text)).toEqual(['Lý do', 'Số tiền', 'Nhân viên']);
    expect(spans.every((s) => text.slice(s.start, s.end) === s.text)).toBe(
      true,
    );
    expect(quotedSpans('no quotes, "unclosed')).toEqual([]);
  });
});
