import { describe, expect, it } from 'vitest';
import { validateCustody, validateKeyRequest } from '../src/trust/index.js';
import { kindOf } from './rotate-fixture.js';

describe('custody declarations (T1.15)', () => {
  it('maps the owner words to declared values and refuses anything else', () => {
    expect(validateCustody('file')).toBe('declared-file');
    expect(validateCustody('hardware')).toBe('declared-hardware');
    for (const bad of ['declared-file', 'software', ''])
      expect(kindOf(() => validateCustody(bad))).toBe('trust_entry_invalid:');
  });
});

describe('reviewer key requests (T1.15)', () => {
  it('normalises the person to NFC and refuses hidden or oversized text', () => {
    const raw = { person: 'Nguyên', scope: 'flows', expires: '30' };
    expect(validateKeyRequest(raw).person).toBe('Nguyên');
    for (const person of [
      '',
      ' Alice',
      'Alice ',
      'Ali​ce',
      'Ali\nce',
      'Ali ce',
      'a'.repeat(129),
    ])
      expect(kindOf(() => validateKeyRequest({ ...raw, person }))).toBe(
        'trust_entry_invalid:',
      );
    expect(
      validateKeyRequest({ ...raw, person: 'a'.repeat(128) }).person,
    ).toHaveLength(128);
  });

  it('takes only the scopes flows and spec', () => {
    const raw = { person: 'Alice', scope: 'flows', expires: '30' };
    expect(validateKeyRequest({ ...raw, scope: 'spec' }).scope).toBe('spec');
    for (const scope of ['', 'FLOWS', 'both', 'flows,spec'])
      expect(kindOf(() => validateKeyRequest({ ...raw, scope }))).toBe(
        'trust_entry_invalid:',
      );
  });

  it('takes whole days from 1 to 365 and no default', () => {
    const raw = { person: 'Alice', scope: 'flows' };
    expect(validateKeyRequest({ ...raw, expires: '1' }).days).toBe(1);
    expect(validateKeyRequest({ ...raw, expires: '365' }).days).toBe(365);
    for (const expires of ['', '0', '366', '1.5', '-1', 'abc', '030', '1e2'])
      expect(kindOf(() => validateKeyRequest({ ...raw, expires }))).toBe(
        'trust_entry_invalid:',
      );
  });
});
