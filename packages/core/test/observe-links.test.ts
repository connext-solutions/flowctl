import { describe, expect, it } from 'vitest';
import { mayOpen, pageLinks, pagePath } from '../src/observe/index.js';
import type { LinkRules } from '../src/observe/index.js';

const ORIGIN = 'http://127.0.0.1:5173';
const RULES: LinkRules = {
  scope: {
    envOrigin: ORIGIN,
    visit: [ORIGIN],
    call: [ORIGIN],
    allow: [],
    deny: ['/admin/**'],
    productionHosts: [],
  },
  loginUrl: '/login',
  words: [],
};
const link = (href: string, name = 'Mở', target = '', download = false) => ({
  href,
  name,
  target,
  download,
});

/** Which links a crawl keeps and follows (T2.2, ADR 0033): pure rules, no browser. */
describe('crawl links', () => {
  it('identifies a page by its path on the env origin only', () => {
    expect(pagePath(`${ORIGIN}/a/b?id=7#x`, ORIGIN)).toBe('/a/b');
    expect(pagePath(`${ORIGIN}/map#/admin/settings`, ORIGIN)).toBe('/map');
    for (const other of [
      'https://evil.example/x',
      'http://localhost.evil.example/',
      'javascript:alert(1)',
      'data:text/html,<p>x</p>',
      'mailto:a@b.c',
      'not a url',
    ])
      expect(pagePath(other, ORIGIN)).toBeUndefined();
  });

  it('opens nothing denied, nothing on the login path and no side-effecting GET', () => {
    expect(mayOpen('/requests', ORIGIN, RULES)).toBe(true);
    expect(mayOpen('/admin/settings', ORIGIN, RULES)).toBe(false);
    expect(mayOpen('/map/%252e%252e/admin', ORIGIN, RULES)).toBe(false);
    expect(mayOpen('/login', ORIGIN, RULES)).toBe(false);
    expect(mayOpen('/app/logout', ORIGIN, RULES)).toBe(false);
    expect(mayOpen('/items/1/delete', ORIGIN, RULES)).toBe(false);
    expect(mayOpen('/items', ORIGIN, { ...RULES, words: ['items'] })).toBe(
      false,
    );
  });

  it('sorts and dedupes, and follows a path only when no link to it is a popup, a download or destructive', () => {
    const got = pageLinks(
      [
        link(`${ORIGIN}/b`),
        link(`${ORIGIN}/a?x=1`),
        link(`${ORIGIN}/a`),
        link(`${ORIGIN}/popup`, 'Mở', '_blank'),
        link(`${ORIGIN}/file.csv`, 'Tải', '', true),
        link(`${ORIGIN}/approvals`, 'Phê duyệt'),
        link(`${ORIGIN}/c`),
        link(`${ORIGIN}/c`, 'Xoá tất cả'),
        link('https://evil.example/x'),
      ],
      ORIGIN,
      RULES,
    );
    expect(got.links).toEqual([
      '/a',
      '/approvals',
      '/b',
      '/c',
      '/file.csv',
      '/popup',
    ]);
    expect(got.follow).toEqual(['/a', '/b']);
  });
});
