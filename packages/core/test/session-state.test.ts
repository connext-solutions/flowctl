import { describe, expect, it } from 'vitest';
import {
  cookieMatches,
  filterState,
  type StorageState,
} from '../src/run/index.js';

/** Sessions hold only the env's own origins (ADR 0024 section 4, issue #50). */
describe('cookieMatches', () => {
  it.each([
    ['app.example', 'app.example', true],
    ['app.example', 'sub.app.example', false],
    ['.example.com', 'example.com', true],
    ['.example.com', 'app.example.com', true],
    ['.example.com', 'evil-example.com', false],
    ['.example.com', 'example.com.evil', false],
    ['.0.0.1', '127.0.0.1', false],
    ['.example', 'app.example', true],
    ['localhost', 'localhost', true],
    ['App.Example', 'app.example', true],
  ])('a cookie for %s is sent to %s: %s', (domain, host, sent) => {
    expect(cookieMatches(domain, host)).toBe(sent);
  });
});

const cookie = (name: string, domain: string) => ({
  name,
  value: `${name}-value`,
  domain,
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: 'Lax' as const,
});

describe('filterState', () => {
  const state: StorageState = {
    cookies: [
      cookie('sid', 'app.example'),
      cookie('wide', '.app.example'),
      cookie('idp', 'sso.idp.example'),
      cookie('prod', 'prod.example.com'),
    ],
    origins: [
      {
        origin: 'https://app.example',
        localStorage: [{ name: 'k', value: 'v' }],
      },
      {
        origin: 'https://sso.idp.example',
        localStorage: [{ name: 't', value: 'secret' }],
      },
    ],
  };

  it('keeps the env origin and its trusted origins, and names what it dropped without a value', () => {
    const { state: kept, dropped } = filterState(state, [
      'https://app.example',
      'https://api.app.example',
    ]);
    expect(kept.cookies.map((c) => c.name)).toEqual(['sid', 'wide']);
    expect(kept.origins.map((o) => o.origin)).toEqual(['https://app.example']);
    expect(dropped).toEqual([
      'cookie domain sso.idp.example',
      'cookie domain prod.example.com',
      'storage of https://sso.idp.example',
    ]);
    expect(dropped.join(' ')).not.toContain('-value');
    expect(dropped.join(' ')).not.toContain('secret');
  });
});
