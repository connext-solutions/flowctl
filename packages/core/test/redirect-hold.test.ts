import { describe, expect, it } from 'vitest';
import { hopMethod, hopTarget } from '../src/run/redirect-hold.js';

describe('hopMethod (WHATWG fetch, HTTP-redirect fetch)', () => {
  it.each([
    [307, 'DELETE', 'DELETE'],
    [308, 'patch', 'PATCH'],
    [303, 'POST', 'GET'],
    [303, 'DELETE', 'GET'],
    [303, 'HEAD', 'HEAD'],
    [301, 'POST', 'GET'],
    [302, 'POST', 'GET'],
    [302, 'DELETE', 'DELETE'],
    [301, 'GET', 'GET'],
  ])('a %i answer to %s is followed with %s', (status, method, hop) => {
    expect(hopMethod(status, method)).toBe(hop);
  });
});

const BASE = 'https://app.example/a/b?x=1';

describe('hopTarget (ADR 0024 section 3, every redirect hop)', () => {
  it.each([301, 302, 303, 307, 308])(
    'resolves the Location of a %i against the request URL',
    (status) => {
      expect(hopTarget(status, '../c', BASE)).toBe('https://app.example/c');
      expect(hopTarget(status, '//evil.example/x', BASE)).toBe(
        'https://evil.example/x',
      );
    },
  );

  it.each([200, 201, 300, 304, undefined])(
    'is undefined for a %s answer, which the browser does not follow',
    (status) => {
      expect(hopTarget(status, 'https://evil.example/', BASE)).toBeUndefined();
    },
  );

  it('is undefined for a redirect without a Location', () => {
    expect(hopTarget(302, undefined, BASE)).toBeUndefined();
  });

  it('returns a Location that does not resolve as written, so the judge refuses it', () => {
    expect(hopTarget(302, 'http://[bad', BASE)).toBe('http://[bad');
  });

  it.each([
    ['\\\\evil.example/x', 'https://evil.example/x'],
    ['/\\evil.example/x', 'https://evil.example/x'],
    ['\t//evil.example/x', 'https://evil.example/x'],
    ['https://evil.example\t/x', 'https://evil.example/x'],
  ])(
    'resolves %j the way a browser does, to another host',
    (location, href) => {
      expect(hopTarget(302, location, BASE)).toBe(href);
    },
  );
});
