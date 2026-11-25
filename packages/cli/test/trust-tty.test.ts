import { describe, expect, it } from 'vitest';
import { stripPasteMarkers } from '../src/trust-tty.js';

/** A pasted answer reads the same as a typed one, whether or not the terminal brackets the paste. */
describe('trust prompt input', () => {
  it('drops the bracketed-paste markers around a pasted passphrase', () => {
    expect(
      stripPasteMarkers('\u001b[200~correct horse battery\u001b[201~'),
    ).toBe('correct horse battery');
  });

  it('keeps a typed answer, spaces included, as it is', () => {
    expect(stripPasteMarkers('  two spaces each side  ')).toBe(
      '  two spaces each side  ',
    );
  });
});
