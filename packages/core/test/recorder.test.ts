import { describe, expect, it } from 'vitest';
import { parseAriaLine, templateName } from '../src/browser/recorder.js';

describe('parseAriaLine', () => {
  it('reads role and accessible name', () => {
    expect(parseAriaLine('- button "Gửi" [pressed]')).toEqual({
      role: 'button',
      name: 'Gửi',
    });
    expect(parseAriaLine('- textbox "Lý do": abc')).toEqual({
      role: 'textbox',
      name: 'Lý do',
    });
    expect(parseAriaLine('- button "Say \\"hi\\""')).toEqual({
      role: 'button',
      name: 'Say "hi"',
    });
  });

  it('unwraps the YAML-quoted form Playwright uses for names with braces or quotes', () => {
    expect(parseAriaLine(`- 'button "Duyệt Tổng {{env.org}}"': Duyệt`)).toEqual(
      { role: 'button', name: 'Duyệt Tổng {{env.org}}' },
    );
    expect(parseAriaLine(`- 'button "It''s: {a}"'`)).toEqual({
      role: 'button',
      name: "It's: {a}",
    });
    expect(parseAriaLine('- "button \\"x y\\""')).toEqual({
      role: 'button',
      name: 'x y',
    });
  });

  it('gives an empty name to unnamed elements and rejects other lines', () => {
    expect(parseAriaLine('- combobox')).toEqual({ role: 'combobox', name: '' });
    expect(parseAriaLine('text: hello')).toBeUndefined();
  });
});

describe('templateName', () => {
  const uid = (v: string) => [{ value: v, template: '{{uid}}' }];

  it('turns the run uid back into {{uid}}', () => {
    expect(templateName('Việc ab12cd34', uid('ab12cd34'))).toBe('Việc {{uid}}');
    expect(templateName('Việc', [])).toBe('Việc');
  });

  it('keeps a literal {{ in the name from being expanded on replay', () => {
    expect(templateName('Tổng {{total}}', uid('ab12cd34'))).toBe(
      'Tổng {{lbrace}}total}}',
    );
    expect(templateName('{{x}} ab12cd34', uid('ab12cd34'))).toBe(
      '{{lbrace}}x}} {{uid}}',
    );
  });

  it('turns a templated input value back into its template, longest value first (#24)', () => {
    const known = [
      {
        value: 'Nghỉ 06/10 ab12cd34',
        template: 'Nghỉ {{today+1:DD/MM}} {{uid}}',
      },
      { value: 'ab12cd34', template: '{{uid}}' },
    ];
    expect(templateName('Duyệt Nghỉ 06/10 ab12cd34', known)).toBe(
      'Duyệt Nghỉ {{today+1:DD/MM}} {{uid}}',
    );
    expect(templateName('Hạn 06/10 {{x}} ab12cd34', known)).toBe(
      'Hạn 06/10 {{lbrace}}x}} {{uid}}',
    );
  });
});
