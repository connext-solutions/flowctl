import { describe, expect, it } from 'vitest';
import {
  checkHookEnv,
  localeAllowed,
  pgpassShapeOk,
} from '../src/trust/index.js';

/**
 * C4 of T1.0: the hook env allowlist, the pinned values, the locales and the `.pgpass` shape (ADR 0021
 * Amendment 2026-11-02 sections 9, 10 and 12, and the owner's locale decision of 2026-11-03).
 */
describe('hook env allowlist', () => {
  it.each([
    'AWS_SECRET_ACCESS_KEY',
    'pythonpath',
    'Http_Proxy',
    'PYTHONPATH',
    'PGSERVICEFILE',
    'pgpassfile',
    'PGSSLROOTCERT',
    'PSQLRC',
    'PAGER',
    'PGFOO',
    'TYPESAFE_API_KEY',
    '1BAD',
  ])('refuses %s', (name) => {
    expect(checkHookEnv([name], {})?.problem).toBe('env_name_refused');
  });

  it('accepts PGPASSWORD and PGCONNECT_TIMEOUT without a value', () => {
    expect(
      checkHookEnv(['PGPASSWORD', 'PGCONNECT_TIMEOUT'], {}),
    ).toBeUndefined();
  });

  it('never pins a secret or another pass-through name', () => {
    expect(
      checkHookEnv(['PGPASSWORD'], { PGPASSWORD: 'secret' })?.problem,
    ).toBe('env_name_refused');
  });

  it('needs a pin for PGHOST and a valid value', () => {
    expect(checkHookEnv(['PGHOST'], {})?.problem).toBe('env_value_unpinned');
    expect(checkHookEnv(['PGHOST'], { PGHOST: 'db.local' })).toBeUndefined();
    for (const [name, value] of [
      ['PGHOST', '/var/run/postgresql'],
      ['PGSSLMODE', 'bogus'],
      ['PGHOSTADDR', '1.2.3.4,5.6.7.8'],
      ['PGHOSTADDR', 'fe80::1%eth0'],
      ['PGOPTIONS', 'a\nb'],
    ] as const)
      expect(checkHookEnv([name], { [name]: value })?.problem).toBe(
        'env_value_invalid',
      );
  });

  it('refuses a pin whose name is not in env, and a duplicate name', () => {
    expect(checkHookEnv([], { PGHOST: 'h' })?.problem).toBe('env_name_refused');
    expect(checkHookEnv(['PGPASSWORD', 'PGPASSWORD'], {})?.problem).toBe(
      'env_name_refused',
    );
  });
});

describe('hook locales (owner decision 2026-11-03)', () => {
  it.each([
    'vi_VN.UTF-8',
    'en_US.UTF-8',
    'en_GB.utf8',
    'C',
    'POSIX',
    'C.UTF-8',
  ])('passes %s', (v) => {
    expect(localeAllowed(v)).toBe(true);
  });
  it.each([
    'ja_JP.SJIS',
    'zh_TW.BIG5',
    'zh_CN.GBK',
    'fr_FR.UTF-8',
    'en_US',
    'vi_VN',
    '../x',
    '',
  ])('drops %j', (v) => {
    expect(localeAllowed(v)).toBe(false);
  });
});

describe('.pgpass shape', () => {
  const ok = (s: string): boolean => pgpassShapeOk(Buffer.from(s));
  it('accepts five fields, comments, empty lines and a last line without LF', () => {
    expect(ok('# c\n\ndb:5432:app:u:p\\:w')).toBe(true);
  });
  it.each([
    ['four fields', 'h:1:d:u\n'],
    ['an empty field', 'h::d:u:p\n'],
    ['a * host', '*:1:d:u:p\n'],
    ['a CR', 'h:1:d:u:p\r\n'],
    ['a whitespace-only line', ' \n'],
    ['5 KiB', `# ${'x'.repeat(5000)}\n`],
  ])('refuses %s', (_name, s) => {
    expect(ok(s)).toBe(false);
  });
});
