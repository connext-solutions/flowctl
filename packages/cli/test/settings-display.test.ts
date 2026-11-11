import { describe, expect, it } from 'vitest';
import { originDisplay } from '../src/trust-settings.js';

describe('originDisplay (ADR 0025 section 3 display rules)', () => {
  it('shows the Unicode form next to an internationalised host', () => {
    expect(originDisplay('https://xn--bcher-kva.example')).toBe(
      'https://xn--bcher-kva.example (bücher.example)',
    );
  });

  it('leaves an ASCII origin as it is', () => {
    expect(originDisplay('https://erp.example.com')).toBe(
      'https://erp.example.com',
    );
  });
});
