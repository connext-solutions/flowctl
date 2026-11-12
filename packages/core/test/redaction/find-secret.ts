import { randomUUID } from 'node:crypto';

/**
 * Finding a secret in output bytes, in every form a leak can take (T1.5): as typed, inside base64 at each of the
 * three byte offsets (standard and URL-safe alphabets), URL-encoded, JSON-escaped, HTML-escaped, as hex, and cut
 * to a prefix or a suffix. The redaction suite runs it over every file, request body and line a run produces.
 */

/** The shortest prefix or suffix of the secret that counts as a leak. */
export const MIN_PART = 8;

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');

const toUrlSafe = (b64: string): string =>
  b64.replaceAll('+', '-').replaceAll('/', '_');

/**
 * The base64 characters that encode only the secret's bits when it starts `offset` bytes into a longer stream: the
 * characters shared by the secret's base64 there, whatever bytes come before and after it.
 */
function base64Core(bytes: Buffer, offset: number): string {
  const padded = Buffer.concat([Buffer.alloc(offset), bytes]);
  const start = Math.ceil((offset * 8) / 6);
  const end = Math.floor(((offset + bytes.length) * 8) / 6);
  return padded.toString('base64').slice(start, end);
}

const code = (ch: string): number => ch.codePointAt(0) ?? 0;

/** `\uXXXX` for every character outside ASCII (surrogate pairs as two escapes), the rest JSON-escaped. */
function jsonAscii(secret: string, upper: boolean): string {
  return JSON.stringify(secret)
    .slice(1, -1)
    .replace(/[^\x20-\x7e]/g, (c) => {
      const hex = c.charCodeAt(0).toString(16).padStart(4, '0');
      return `\\u${upper ? hex.toUpperCase() : hex}`;
    });
}

const HTML_NAMED: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  Đ: '&Dstrok;',
  đ: '&dstrok;',
  '€': '&euro;',
};

/** Every non-ASCII or HTML-special character replaced by `escape(ch)`. */
function htmlEscape(secret: string, escape: (ch: string) => string): string {
  return [...secret]
    .map((ch) => (/[&<>"']/.test(ch) || code(ch) > 0x7e ? escape(ch) : ch))
    .join('');
}

/**
 * The byte strings that reveal `secret`, by form name. Forms the secret makes equal (`json` and `plain` when it has
 * nothing to escape) are each still listed, so a hit names every form it matches.
 */
export function secretForms(secret: string): Map<string, Buffer> {
  const bytes = utf8(secret);
  const part = Math.max(MIN_PART, Math.ceil([...secret].length / 2));
  const chars = [...secret];
  const url = encodeURIComponent(secret);
  const forms: [string, string][] = [
    ['plain', secret],
    ['url', url],
    ['url-lower', url.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase())],
    ['url-form', url.replaceAll('%20', '+')],
    ['json', JSON.stringify(secret).slice(1, -1)],
    ['json-ascii', jsonAscii(secret, false)],
    ['json-ascii-upper', jsonAscii(secret, true)],
    ['html-named', htmlEscape(secret, (c) => HTML_NAMED[c] ?? `&#${code(c)};`)],
    ['html-decimal', htmlEscape(secret, (c) => `&#${code(c)};`)],
    ['html-hex', htmlEscape(secret, (c) => `&#x${code(c).toString(16)};`)],
    ['hex', bytes.toString('hex')],
    ['hex-upper', bytes.toString('hex').toUpperCase()],
    ['prefix', chars.slice(0, part).join('')],
    ['suffix', chars.slice(-part).join('')],
  ];
  for (const offset of [0, 1, 2]) {
    const core = base64Core(bytes, offset);
    forms.push(
      [`base64+${offset}`, core],
      [`base64url+${offset}`, toUrlSafe(core)],
    );
  }
  return new Map(forms.map(([name, form]) => [name, utf8(form)]));
}

/**
 * The names of the forms of `secret` found in `data` (empty when it holds none), compared byte for byte.
 *
 * @example findSecret(readFileSync('run.json'), secret) // [] or ['plain', 'prefix', 'suffix']
 */
export function findSecret(
  data: Uint8Array | string,
  secret: string,
): string[] {
  const buf = typeof data === 'string' ? utf8(data) : Buffer.from(data);
  return [...secretForms(secret)]
    .filter(([, needle]) => buf.includes(needle))
    .map(([name]) => name);
}

/** A secret no output has ever held: fixed letters, a fresh random part, a dash and two non-ASCII characters. */
export function freshSecret(): string {
  return `S3cr3t-${randomUUID().slice(0, 13)}-Đ€`;
}
