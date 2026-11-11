import { describe, expect, it } from 'vitest';
import {
  pathGlob,
  inScope,
  normalisePath,
  type Scope,
} from '../src/browser/index.js';
import { isPrivateHost } from '../src/foundation/index.js';

const ENV = 'https://stg.example.com';
const SCOPE: Scope = {
  envOrigin: ENV,
  visit: [ENV, 'https://sso.example.com'],
  call: [ENV, 'https://api.example.com'],
  allow: [],
  deny: ['/admin/**'],
  productionHosts: ['erp.example.com'],
};

const ok = (url: string, kind: 'visit' | 'call' = 'visit', s = SCOPE) =>
  inScope(url, kind, s).ok;

describe('inScope (ADR 0024 section 3)', () => {
  it('rule 1: only http(s); http only to loopback or RFC 1918; no userinfo', () => {
    for (const u of [
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'blob:https://stg.example.com/1',
      'file:///etc/passwd',
      'ftp://stg.example.com/',
    ])
      expect(ok(u), u).toBe(false);
    expect(ok('http://stg.example.com/')).toBe(false);
    expect(ok('https://u:p@stg.example.com/')).toBe(false);
    const local: Scope = {
      ...SCOPE,
      envOrigin: 'http://127.0.0.1:4200',
      visit: ['http://127.0.0.1:4200', 'http://10.0.0.5', 'http://192.168.1.2'],
    };
    expect(ok('http://127.0.0.1:4200/x', 'visit', local)).toBe(true);
    expect(ok('http://10.0.0.5/x', 'visit', local)).toBe(true);
    expect(ok('http://192.168.1.2/x', 'visit', local)).toBe(true);
    for (const host of [
      '10.evil.com',
      '127.attacker.net',
      '192.168.1.2.evil.test',
    ])
      expect(isPrivateHost(host), host).toBe(false);
    expect(isPrivateHost('172.31.0.1')).toBe(true);
    expect(isPrivateHost('172.32.0.1')).toBe(false);
    expect(
      ok('http://10.evil.com/', 'call', {
        ...local,
        call: ['http://10.evil.com'],
      }),
    ).toBe(false);
  });

  it('rule 2: origins compare after parsing; a subdomain-suffix host and a userinfo trick fail', () => {
    expect(ok('https://STG.Example.com:443/x')).toBe(true);
    expect(ok('https://stg.example.com.evil.test/')).toBe(false);
    expect(ok('https://evilstg.example.com/')).toBe(false);
    expect(ok('https://stg.example.com@evil.test/')).toBe(false);
    expect(ok('https://stg.example.com:8443/')).toBe(false);
  });

  it('visit and call: a page may call its own origin and the call set, but only open the visit set', () => {
    expect(ok('https://api.example.com/v1', 'call')).toBe(true);
    expect(ok('https://api.example.com/v1', 'visit')).toBe(false);
    expect(ok('https://sso.example.com/login', 'call')).toBe(true);
    expect(ok('https://cdn.example.net/app.js', 'call')).toBe(false);
  });

  it('production hosts are refused on every scheme and port', () => {
    const s = { ...SCOPE, visit: [...SCOPE.visit, 'https://erp.example.com'] };
    expect(ok('https://erp.example.com/', 'visit', s)).toBe(false);
    expect(ok('https://erp.example.com:8443/api', 'call', s)).toBe(false);
    expect(ok('https://ERP.example.com./', 'visit', s)).toBe(false);
  });

  it('rule 3: the path is decoded to a fixed point, dots resolved and ;params stripped before deny matches', () => {
    expect(ok('https://stg.example.com/admin/users')).toBe(false);
    expect(ok('https://stg.example.com/ADMIN/users')).toBe(false);
    expect(ok('https://stg.example.com/x/%2e%2e/admin/users')).toBe(false);
    expect(ok('https://stg.example.com/x/%252e%252e/admin/users')).toBe(false);
    expect(ok('https://stg.example.com/admin;jsessionid=1/users')).toBe(false);
    expect(ok('https://stg.example.com/%61dmin/users')).toBe(false);
    expect(ok(`https://stg.example.com/${'%25'.repeat(6)}61dmin`)).toBe(false);
    expect(ok('https://stg.example.com/hrm/admins-list')).toBe(true);
  });

  it('rule 3: doubled slashes, encoded slashes and ..; cannot hide a denied segment', () => {
    for (const p of [
      '//logout',
      '/%2F%2Flogout',
      '//admin/delete',
      '/%2Fadmin/delete',
      '/hrm/..//admin/x',
      '/hrm/..;/admin/delete',
      '/hrm/x/..%3b/..%3b/admin',
    ])
      expect(ok(`https://stg.example.com${p}`, 'call'), p).toBe(false);
    const s = { ...SCOPE, allow: ['/hrm/**'] };
    expect(ok('https://stg.example.com/hrm/..;/admin', 'visit', s)).toBe(false);
  });

  it('a deny pattern without a leading slash is rooted, never everything', () => {
    const s = { ...SCOPE, deny: ['admin/**'] };
    expect(ok('https://stg.example.com/admin/x', 'call', s)).toBe(false);
    expect(ok('https://stg.example.com/hrm/x', 'call', s)).toBe(true);
  });

  it('rule 3: allow is case-sensitive, applies to visits on the env origin, and deny wins over it', () => {
    const s = { ...SCOPE, allow: ['/hrm/**', '/admin/reports'] };
    expect(ok('https://stg.example.com/hrm/leave/1', 'visit', s)).toBe(true);
    expect(ok('https://stg.example.com/HRM/leave/1', 'visit', s)).toBe(false);
    expect(ok('https://stg.example.com/finance', 'visit', s)).toBe(false);
    expect(ok('https://stg.example.com/finance', 'call', s)).toBe(true);
    expect(ok('https://stg.example.com/admin/reports', 'visit', s)).toBe(false);
    expect(ok('https://sso.example.com/login', 'visit', s)).toBe(true);
  });

  it('rule 5: a hash route is judged like a path', () => {
    expect(ok('https://stg.example.com/#/admin/settings')).toBe(false);
    expect(ok('https://stg.example.com/#/hrm/leave')).toBe(true);
    expect(ok('https://stg.example.com/#section-2')).toBe(true);
  });

  it('the built-in deny list stops logout whatever the repo says', () => {
    const open = { ...SCOPE, deny: [] };
    for (const p of ['/logout', '/auth/logout', '/api/sign-out', '/Logout/now'])
      expect(ok(`https://stg.example.com${p}`, 'call', open), p).toBe(false);
    expect(ok('https://stg.example.com/logouts', 'call', open)).toBe(true);
  });

  it('names the command that adds a missing origin', () => {
    const v = inScope('https://cdn.example.net/a.js', 'call', SCOPE);
    expect(v.ok).toBe(false);
    if (!v.ok)
      expect(v.reason).toContain(
        'flowctl trust add origin <env> call https://cdn.example.net',
      );
  });
});

describe('normalisePath and pathGlob', () => {
  it('decodes, resolves and refuses paths that never settle or smuggle a separator', () => {
    expect(normalisePath('/a/%2e%2e/b')).toBe('/b');
    expect(normalisePath('/a;x=1/b;y')).toBe('/a/b');
    expect(normalisePath('/a%3fb')).toBeUndefined();
    expect(normalisePath('/a%5cb')).toBeUndefined();
    expect(normalisePath('/a%0ab')).toBeUndefined();
    expect(normalisePath('/%E0%A4%A')).toBeUndefined();
  });

  it('matches * within a segment and ** across any number of segments', () => {
    expect(pathGlob('/hrm/**', false).test('/hrm')).toBe(true);
    expect(pathGlob('/hrm/**', false).test('/hrm/a/b')).toBe(true);
    expect(pathGlob('/hrm/*', false).test('/hrm/a/b')).toBe(false);
    expect(pathGlob('/**/logout', true).test('/logout')).toBe(true);
    expect(pathGlob('/a.b/*', false).test('/aXb/c')).toBe(false);
  });
});
