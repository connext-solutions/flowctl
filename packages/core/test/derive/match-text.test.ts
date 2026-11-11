import { describe, expect, it } from 'vitest';
import { compareText, fold } from '../../src/derive/index.js';

describe('matcher text rules (ADR 0034 on ADR 0020)', () => {
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

  it('lower-cases the whole string, so İ folds to i with a dot above (unlike an occurrence)', () => {
    expect(compareText('i\u0307', 'İ')).toBe('folded');
  });
});
