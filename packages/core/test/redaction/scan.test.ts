import { describe, expect, it } from 'vitest';
import { freshSecret } from './find-secret.js';
import { consoleUrls, leaksIn, scrubTraceLine } from './scan.js';

/**
 * The redaction suite's trace scan (T1.5): only the source URL of a console event is left out, the known leak of ADR
 * 0030 "Not covered"; every other part of a trace line is scanned.
 */
const secret = freshSecret();
const q = encodeURIComponent(secret);
const consoleLine = (text: string, url: string): string =>
  JSON.stringify({
    type: 'console',
    messageType: 'error',
    text,
    location: { url, lineNumber: 0, columnNumber: 0 },
  });

describe('scrubTraceLine', () => {
  it('drops the source URL of a console event and nothing else', () => {
    const line = scrubTraceLine(consoleLine('Lỗi', `http://h/api?q=${q}`));
    expect(leaksIn([['line', line]], secret)).toEqual([]);
    expect(JSON.parse(line)).toEqual({
      type: 'console',
      messageType: 'error',
      text: 'Lỗi',
      location: { lineNumber: 0, columnNumber: 0 },
    });
  });

  it('keeps a secret in the text of a console event', () => {
    const line = scrubTraceLine(consoleLine(`Lỗi ${secret}`, 'http://h/'));
    expect(leaksIn([['line', line]], secret)).not.toEqual([]);
  });

  it('keeps every other line as it is, a URL in it and an unparsable line included', () => {
    const before = JSON.stringify({
      type: 'before',
      params: { url: `http://h/api?q=${q}` },
    });
    for (const l of [before, `{"type":"console", ${secret}`, ''])
      expect(scrubTraceLine(l)).toBe(l);
  });
});

describe('consoleUrls', () => {
  it('lists the source URL of every console event, and only those', () => {
    const text = [
      consoleLine('a', 'http://h/1'),
      JSON.stringify({ type: 'before', params: { url: 'http://h/2' } }),
      'not json',
      consoleLine('b', 'http://h/3'),
    ].join('\n');
    expect(consoleUrls(text)).toEqual(['http://h/1', 'http://h/3']);
  });
});
