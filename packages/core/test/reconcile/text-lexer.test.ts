import { describe, expect, it } from 'vitest';
import {
  decodeSource,
  lex,
  normaliseText,
  parseJsonEntries,
} from '../../src/reconcile/index.js';

describe('normaliseText (ADR 0020 section d)', () => {
  it('normalises to NFC, collapses ASCII whitespace and trims', () => {
    expect(normaliseText('  Đã\t gửi \n đơn ')).toEqual({
      ok: true,
      text: 'Đã gửi đơn',
    });
    expect(normaliseText('Đa\u0303 gửi')).toEqual({
      ok: true,
      text: 'Đã gửi',
    });
  });

  it('refuses hidden, compatibility and non-ASCII digit characters', () => {
    for (const s of [
      'a\u200bb',
      'a\u2028b',
      'a\u00a0b',
      'ﬁle',
      '\u0661\u0662',
      'a\u0007b',
      '\ue000',
      'a\ud800b',
      '\udc00',
      '   ',
    ])
      expect(normaliseText(s).ok).toBe(false);
  });
});

describe('decodeSource', () => {
  it('strips a UTF-8 BOM and refuses binary, UTF-16 and invalid UTF-8', () => {
    expect(decodeSource(Buffer.from('\ufeffabc'))).toEqual({
      ok: true,
      text: 'abc',
    });
    expect(decodeSource(Buffer.from([0x61, 0x00, 0x62]))).toEqual({
      ok: false,
      rule: 'binary',
    });
    expect(decodeSource(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toEqual({
      ok: false,
      rule: 'not utf-8',
    });
    for (const bom of [
      [0x00, 0x00, 0xfe, 0xff],
      [0xff, 0xfe, 0x00, 0x00],
    ])
      expect(decodeSource(Buffer.from([...bom, 0, 0, 0, 0x61]))).toEqual({
        ok: false,
        rule: 'not utf-8',
      });
    expect(decodeSource(Buffer.from([0x61, 0xc3, 0x28]))).toEqual({
      ok: false,
      rule: 'not utf-8',
    });
  });
});

describe('lex', () => {
  it('yields identifiers, punctuation and decoded string literals with lines', () => {
    const toks = lex(
      "const a = 'x\\u00e9';\n// 'no'\n/* 'no'\n*/ b(\"y\", `z`)",
    );
    expect(toks.filter((t) => t.type === 'str')).toEqual([
      { type: 'str', value: 'xé', line: 1 },
      { type: 'str', value: 'y', line: 4 },
      { type: 'str', value: 'z', line: 4 },
    ]);
    expect(toks.find((t) => t.value === 'b')?.line).toBe(4);
  });

  it('keeps a template with a substitution out of the literals', () => {
    const toks = lex('f(`a${b + `c`}d`, "e")');
    expect(toks.filter((t) => t.type === 'str').map((t) => t.value)).toEqual([
      'e',
    ]);
  });

  it('skips regular expressions and recovers from an unterminated string', () => {
    const toks = lex("x = /'/g; y = 'ok'\n<p>Don't</p>\nz('after')");
    expect(toks.filter((t) => t.type === 'str').map((t) => t.value)).toEqual([
      'ok',
      'after',
    ]);
  });

  it('keeps the rest of a line after an unclosed quote or regular expression', () => {
    const strs = (src: string): string[] =>
      lex(src)
        .filter((t) => t.type === 'str')
        .map((t) => t.value);
    expect(strs('<p>Don\'t</p> <Route path="/x" /> {"y"}')).toEqual([
      '/x',
      'y',
    ]);
    expect(strs("x = /[a; f('ok')")).toEqual(['ok']);
    expect(strs('"\\u{41}" "\\u{110000}" "\\u{000000041}"')).toEqual([
      'A',
      '{110000}',
      '{000000041}',
    ]);
  });

  it('reads </Route> as punctuation, not as a regular expression', () => {
    const toks = lex('<Route path="a"></Route>');
    expect(toks.map((t) => t.value)).toEqual([
      '<',
      'Route',
      'path',
      '=',
      'a',
      '>',
      '<',
      '/',
      'Route',
      '>',
    ]);
  });
});

describe('parseJsonEntries', () => {
  it('flattens string leaves with their key path and line', () => {
    const json =
      '{\n  "a": {\n    "b": "B",\n    "n": 1\n  },\n  "c": ["x", "y"]\n}';
    expect(parseJsonEntries(json)).toEqual([
      { key: 'a.b', text: 'B', line: 3 },
      { key: 'c.0', text: 'x', line: 6 },
      { key: 'c.1', text: 'y', line: 6 },
    ]);
  });

  it('refuses invalid JSON and nesting past the depth cap', () => {
    expect(parseJsonEntries('{"a": "x\ty"}')).toBeUndefined();
    expect(parseJsonEntries('{"a": "\\u00e9\\n"}')?.[0]?.text).toBe('é\n');
    expect(parseJsonEntries('{"a": }')).toBeUndefined();
    expect(parseJsonEntries('{"a": "b"} x')).toBeUndefined();
    expect(parseJsonEntries(`${'['.repeat(100)}${']'.repeat(100)}`)).toBe(
      undefined,
    );
  });
});
