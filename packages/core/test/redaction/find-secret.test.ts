import { describe, expect, it } from 'vitest';
import { maskSecrets } from '../../src/foundation/index.js';
import { findSecret, freshSecret, secretForms } from './find-secret.js';

/**
 * The redaction suite's detector (T1.5): `findSecret` finds a secret in each form it can leak in, inside other bytes,
 * and stays quiet on a decoy that only resembles it, so a clean scan means the secret is absent.
 */
const SECRET = 'S3cr3t-a1b2c3d4-e5f6-Đ€';
const SPACED = 'S3cr3t a1b2c3d4 <&"Đ€>';

const embed = (text: string): string => `{"x":"…${text}…","y":1}`;

describe('findSecret', () => {
  it.each([
    ['plain', SECRET],
    ['url', 'S3cr3t-a1b2c3d4-e5f6-%C4%90%E2%82%AC'],
    ['url-lower', 'S3cr3t-a1b2c3d4-e5f6-%c4%90%e2%82%ac'],
    ['json-ascii', String.raw`S3cr3t-a1b2c3d4-e5f6-\u0110\u20ac`],
    ['json-ascii-upper', String.raw`S3cr3t-a1b2c3d4-e5f6-\u0110\u20AC`],
    ['html-named', 'S3cr3t-a1b2c3d4-e5f6-&Dstrok;&euro;'],
    ['html-decimal', 'S3cr3t-a1b2c3d4-e5f6-&#272;&#8364;'],
    ['html-hex', 'S3cr3t-a1b2c3d4-e5f6-&#x110;&#x20ac;'],
    ['hex', Buffer.from(SECRET).toString('hex')],
    ['hex-upper', Buffer.from(SECRET).toString('hex').toUpperCase()],
    ['prefix', 'S3cr3t-a1b2c3'],
    ['suffix', 'c3d4-e5f6-Đ€'],
  ])('finds the %s form inside other text', (form, text) => {
    expect(findSecret(embed(text), SECRET)).toContain(form);
  });

  it.each([0, 1, 2])(
    'finds the secret inside base64 when it starts %i bytes into the encoded stream, in both alphabets',
    (offset) => {
      const blob = Buffer.concat([
        Buffer.from([0xfb, 0xff, 0xfe].slice(0, offset)),
        Buffer.from(`?>${SECRET}<?`),
      ]);
      const b64 = blob.toString('base64');
      const url = b64.replaceAll('+', '-').replaceAll('/', '_');
      const found = findSecret(b64, SECRET);
      expect(found.some((f) => f.startsWith('base64+'))).toBe(true);
      expect(findSecret(url, SECRET).some((f) => f.startsWith('base64'))).toBe(
        true,
      );
    },
  );

  it.each([0, 1, 2])(
    'finds the ASCII prefix inside base64 when it starts %i bytes into the encoded stream, in both alphabets',
    (offset) => {
      const blob = Buffer.concat([
        Buffer.from([0xfb, 0xff, 0xfe].slice(0, offset)),
        Buffer.from(`${SECRET.slice(0, 12)}#cut#`),
      ]);
      const b64 = blob.toString('base64');
      const url = b64.replaceAll('+', '-').replaceAll('/', '_');
      expect(findSecret(b64, SECRET)).toContain(`prefix-base64+${offset}`);
      expect(findSecret(url, SECRET)).toContain(`prefix-base64url+${offset}`);
      expect(findSecret(b64, SECRET).some((f) => f.startsWith('base64'))).toBe(
        false,
      );
    },
  );

  it('finds the ASCII prefix as hex, in either case', () => {
    const hex = Buffer.from(`${SECRET.slice(0, 12)}#cut#`).toString('hex');
    expect(findSecret(embed(hex), SECRET)).toContain('prefix-hex');
    expect(findSecret(embed(hex.toUpperCase()), SECRET)).toContain(
      'prefix-hex-upper',
    );
    expect(findSecret(embed(hex), SECRET)).not.toContain('hex');
  });

  it('lists no encoded prefix forms when the prefix has fewer than eight ASCII characters', () => {
    const forms = secretForms('Đ€Đ€Đ€Đ€Đ€-abcdefgh-ĐĐĐĐĐĐ');
    expect([...forms.keys()].filter((k) => k.startsWith('prefix-'))).toEqual(
      [],
    );
  });

  it('finds the form and JSON escapes of a secret with spaces and HTML-special characters', () => {
    const sent = new URLSearchParams({ a: SPACED }).toString();
    expect(findSecret(sent, SPACED)).toContain('url-form');
    expect(findSecret(JSON.stringify({ a: SPACED }), SPACED)).toContain('json');
    expect(
      findSecret('S3cr3t a1b2c3d4 &lt;&amp;&quot;&Dstrok;&euro;&gt;', SPACED),
    ).toContain('html-named');
  });

  it('reads raw bytes as well as text', () => {
    const bytes = Buffer.concat([
      Buffer.from([0, 255, 137]),
      Buffer.from(SECRET),
    ]);
    expect(findSecret(new Uint8Array(bytes), SECRET)).toContain('plain');
  });

  it('stays quiet on decoys: one character changed, short parts, the masked text, other base64', () => {
    const decoys = [
      'S3cr3t-a1b2X3d4-e5f6-Đ€',
      'S3cr3t-',
      'f6-Đ€',
      maskSecrets(embed(SECRET), [SECRET]),
      Buffer.from('S3cr3t-a1b2X3d4-e5f6-Đ€').toString('base64'),
      Buffer.from('S3cr3t-a1b2').toString('hex'),
      Buffer.from('S3cr3t-a1b2').toString('base64'),
      Buffer.from('S3cr3t-a1b2X').toString('base64'),
    ];
    for (const d of decoys) expect(findSecret(d, SECRET), d).toEqual([]);
  });

  it('lists all six base64 variants and parts of at least eight characters', () => {
    const forms = secretForms(freshSecret());
    expect(
      [...forms.keys()].filter((k) => k.startsWith('base64')),
    ).toHaveLength(6);
    expect(
      [...forms.keys()].filter((k) => k.startsWith('prefix-base64')),
    ).toHaveLength(6);
    for (const name of ['prefix', 'suffix'])
      expect(forms.get(name)?.toString('utf8').length).toBeGreaterThanOrEqual(
        8,
      );
  });

  it('makes a fresh secret per call, with non-ASCII characters', () => {
    const a = freshSecret();
    expect(a).not.toBe(freshSecret());
    expect(a).toMatch(/[^\x20-\x7e]/);
  });
});
