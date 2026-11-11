/** A text after normalisation, or the reason it is refused. */
export type NormalisedText =
  | { ok: true; text: string }
  | { ok: false; reason: string };

const HIDDEN =
  /[\p{Default_Ignorable_Code_Point}\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u;
const NON_ASCII_DIGIT = /(?![0-9])\p{Nd}/u;

/**
 * Normalises a label, message or query text as ADR 0020 section d does for quotes: Unicode NFC, then runs of
 * ASCII whitespace collapsed to one space and trimmed. Refused (never matched): a hidden or unassigned character
 * (Default_Ignorable_Code_Point, `Cc` left after the collapse, `Cf`, `Zl`, `Zp`, `Co`, `Cn`), a text whose NFKC
 * form differs from its NFC form, a non-ASCII decimal digit, and an empty text.
 *
 * @example normaliseText(' Đã\tgửi ') // { ok: true, text: 'Đã gửi' }
 * @see docs/adr/0020-assertion-provenance.md
 */
export function normaliseText(raw: string): NormalisedText {
  const text = raw
    .normalize('NFC')
    .replace(/[ \t\n\r\f\v]+/g, ' ')
    .trim();
  if (text === '') return { ok: false, reason: 'empty text' };
  if (HIDDEN.test(text))
    return { ok: false, reason: 'hidden or unassigned character' };
  if (text.normalize('NFKC') !== text)
    return { ok: false, reason: 'compatibility character' };
  if (NON_ASCII_DIGIT.test(text))
    return { ok: false, reason: 'non-ASCII digit' };
  return { ok: true, text };
}

/** Decoded source text, or the rule it failed. */
export type DecodedSource =
  | { ok: true; text: string }
  | { ok: false; rule: 'binary' | 'not utf-8' };

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });

/**
 * Decodes file bytes as UTF-8 (a leading BOM is dropped). A UTF-16 or UTF-32 BOM or invalid UTF-8 is
 * `not utf-8`; a NUL byte anywhere is `binary`.
 */
export function decodeSource(bytes: Uint8Array): DecodedSource {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if ((b0 === 0xff && b1 === 0xfe) || (b0 === 0xfe && b1 === 0xff))
    return { ok: false, rule: 'not utf-8' };
  if (bytes.includes(0)) return { ok: false, rule: 'binary' };
  try {
    return { ok: true, text: UTF8.decode(bytes) };
  } catch {
    return { ok: false, rule: 'not utf-8' };
  }
}
