import { describe, expect, it } from 'vitest';
import { pick, readFiles, reasons, valueOf } from './contract-fixture.js';

const FORM = `<form>
  <input name="reason" type="text" required maxlength="200" minlength=1 pattern="[a-z]+">
  <input id="amount" type="number" min="0" max="1000000000" REQUIRED="required">
  <textarea name="note" maxlength='500'></textarea>
  <select name="kind" required><option>A</option></select>
  <input type="text" maxlength="9">
</form>`;

describe('HTML form controls', () => {
  const { facts, skipped } = readFiles({ 'form.html': FORM });
  const html = facts.filter((f) => f.source === 'html');

  it('reads required, minlength, maxlength, min, max and pattern by control name or id', () => {
    expect(valueOf(html, 'reason', 'required')).toBe('true');
    expect(valueOf(html, 'reason', 'maxLength')).toBe('200');
    expect(valueOf(html, 'reason', 'minLength')).toBe('1');
    expect(valueOf(html, 'reason', 'pattern')).toBe('[a-z]+');
    expect(valueOf(html, 'amount', 'min')).toBe('0');
    expect(valueOf(html, 'amount', 'max')).toBe('1000000000');
    expect(valueOf(html, 'amount', 'required')).toBe('true');
    expect(valueOf(html, 'note', 'maxLength')).toBe('500');
    expect(valueOf(html, 'kind', 'required')).toBe('true');
  });

  it('gives the client side, the tag as owner, the line of the tag, and ignores a control with no name', () => {
    expect(pick(html, 'reason', 'maxLength')[0]).toMatchObject({
      side: 'client',
      owner: 'input',
      line: 2,
      pointer: '/input/reason/maxlength',
    });
    expect(html.some((f) => f.value === '9')).toBe(false);
    expect(skipped).toEqual([]);
  });
});

describe('HTML that is not a form control', () => {
  it('takes nothing from comments, script, style or an attribute inside a value', () => {
    const src = [
      '<!-- <input name="ghost" maxlength="1"> -->',
      '<script>document.write(\'<input name="s" maxlength="2">\')</script>',
      '<style>input[name="t"] { }</style>',
      '<input name="real" title=\'<input name="inner" maxlength="3">\' maxlength="4">',
    ].join('\n');
    const { facts } = readFiles({ 'p.htm': src });
    expect(facts.map((f) => f.field)).toEqual(['real']);
    expect(valueOf(facts, 'real', 'maxLength')).toBe('4');
  });

  it('keeps the first of a duplicated attribute and reports the repeat', () => {
    const { facts, skipped } = readFiles({
      'p.html': '<input name="a" maxlength="5" maxlength="9">',
    });
    expect(valueOf(facts, 'a', 'maxLength')).toBe('5');
    expect(reasons(skipped)).toEqual(['duplicate_attribute:maxlength']);
  });

  it('does not decode entities in attribute names, and keeps a date min as written', () => {
    const { facts } = readFiles({
      'p.html':
        '<input name="d" &#109;axlength="1" min="2026-01-01" max="0200">',
    });
    expect(pick(facts, 'd', 'maxLength')).toEqual([]);
    expect(valueOf(facts, 'd', 'min')).toBe('2026-01-01');
    expect(valueOf(facts, 'd', 'max')).toBe('0200');
  });

  it('caps attributes per tag and reports an unclosed tag', () => {
    const many = `<input name="a" ${Array.from({ length: 200 }, (_, i) => `x${i}="1"`).join(' ')} maxlength="5">`;
    const a = readFiles({ 'p.html': many });
    expect(reasons(a.skipped)).toEqual(['too_many_attributes']);
    expect(valueOf(a.facts, 'a', 'maxLength')).toBeUndefined();
    const b = readFiles({ 'p.html': '<input name="a" maxlength="5"' });
    expect(reasons(b.skipped)).toEqual(['unclosed_tag']);
    expect(b.facts).toEqual([]);
  });

  it('stops at the tag cap', () => {
    const { skipped } = readFiles(
      { 'p.html': '<div>'.repeat(50) },
      { limits: { maxTags: 10 } },
    );
    expect(reasons(skipped)).toEqual(['too_many_tags']);
  });
});
