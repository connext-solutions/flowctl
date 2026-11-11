import { describe, expect, it } from 'vitest';
import { globToRegExp, isSubset } from '../src/run/index.js';

describe('globToRegExp', () => {
  it('treats a leading slash as a url suffix and allows a query string', () => {
    const re = globToRegExp('/api/requests');
    expect(re.test('http://h/api/requests')).toBe(true);
    expect(re.test('http://h/v1/api/requests?page=2')).toBe(true);
    expect(re.test('http://h/api/requests/5')).toBe(false);
    expect(
      globToRegExp('/api/requests/*/approve').test(
        'http://h/api/requests/7/approve',
      ),
    ).toBe(true);
    expect(globToRegExp('http://h/a.b*').test('http://h/aXb')).toBe(false);
  });

  it('allows a #fragment after the path or the query string (#29)', () => {
    const re = globToRegExp('/holidays');
    expect(re.test('http://h/holidays#list')).toBe(true);
    expect(re.test('http://h/holidays?y=2026#list')).toBe(true);
    expect(re.test('http://h/holidays/5#list')).toBe(false);
    expect(globToRegExp('*/app').test('http://h/app#/admin/delete')).toBe(
      false,
    );
    expect(globToRegExp('*/app').test('http://h/app#!/admin')).toBe(false);
    expect(globToRegExp('*/app#/admin').test('http://h/app#/admin')).toBe(true);
  });
});

describe('isSubset', () => {
  it('matches nested partial objects and exact arrays', () => {
    expect(isSubset({ type: 'LEAVE' }, { type: 'LEAVE', amount: 2 })).toBe(
      true,
    );
    expect(isSubset({ a: { b: 1 } }, { a: { b: 1, c: 2 } })).toBe(true);
    expect(isSubset({ type: 'LEAVE' }, { type: 'OT' })).toBe(false);
    expect(isSubset([1, 2], [1, 2])).toBe(true);
    expect(isSubset([1], [1, 2])).toBe(false);
    expect(isSubset({ a: 1 }, undefined)).toBe(false);
  });
});
