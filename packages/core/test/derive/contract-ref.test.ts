import { createHash } from 'node:crypto';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  contractRef,
  readContracts,
  resolveContractRef,
  valueSha256,
} from '../../src/derive/index.js';
import { ContainmentError, openRoot } from '../../src/trust/index.js';
import { put, tmp } from '../reconcile/repo.js';
import { fixtureRoot, pick } from './contract-fixture.js';

const refusal = (fn: () => unknown): ContainmentError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContainmentError) return e;
    throw e;
  }
  throw new Error('expected a ContainmentError');
};

const FORM = (max: number): string =>
  `<input name="reason" maxlength="${max}">\n`;

describe('contract references', () => {
  const root = fixtureRoot();
  const { facts } = readContracts(root, { rootName: 'api' });
  const fact = pick(facts, 'reason', 'maxLength', 'openapi')[0];

  it('is root name, file and pointer, deterministic, at most 500 characters and free of invisible characters', () => {
    expect(fact).toBeDefined();
    if (fact === undefined) return;
    const ref = contractRef(fact, 'api');
    expect(ref).toBe(
      'api:openapi.yaml#/components/schemas/NewLeaveRequest/properties/reason/maxLength',
    );
    expect(contractRef(fact, 'api')).toBe(ref);
    for (const f of facts) {
      const r = contractRef(f, 'api');
      expect(r.length).toBeLessThanOrEqual(500);
      expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}]/u.test(r)).toBe(false);
    }
  });

  it('is read again from the file: value, source hash and fact', () => {
    if (fact === undefined) return;
    const got = resolveContractRef(root, contractRef(fact, 'api'), {
      rootName: 'api',
    });
    expect(got?.value).toBe('200');
    expect(got?.fact).toEqual(fact);
    expect(got?.sourceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(valueSha256(fact)).toBe(
      createHash('sha256').update('200').digest('hex'),
    );
  });

  it('gives null when the file, the fact or the symbol is gone, and the new value when it changed', () => {
    const dir = tmp();
    put(dir, 'form.html', FORM(100));
    const r = openRoot(dir, 'contracts');
    const f = readContracts(r).facts[0];
    expect(f).toBeDefined();
    if (f === undefined) return;
    const ref = contractRef(f, 'contracts');
    const before = resolveContractRef(r, ref);
    expect(before?.value).toBe('100');
    writeFileSync(join(dir, 'form.html'), FORM(200));
    const after = resolveContractRef(r, ref);
    expect(after?.value).toBe('200');
    expect(after?.sourceSha256).not.toBe(before?.sourceSha256);
    writeFileSync(join(dir, 'form.html'), '<input name="other">\n');
    expect(resolveContractRef(r, ref)).toBeNull();
    rmSync(join(dir, 'form.html'));
    expect(resolveContractRef(r, ref)).toBeNull();
  });

  it('refuses a ref that is too long, holds an invisible character, names another root or has no pointer', () => {
    const rule = (ref: string): string =>
      refusal(() => resolveContractRef(root, ref)).rule;
    expect(rule(`contracts:openapi.yaml#/${'a'.repeat(600)}`)).toBe(
      'ref length or characters',
    );
    expect(rule('contracts:openapi.yaml#/a\u200bb')).toBe(
      'ref length or characters',
    );
    expect(rule('other:openapi.yaml#/a')).toBe('root name');
    expect(rule('openapi.yaml#/a')).toBe('root name');
    expect(rule('contracts:openapi.yaml')).toBe('no pointer');
  });

  it('refuses a ref whose path is not a plain relative path inside the root', () => {
    for (const path of [
      '../x.yaml',
      '/etc/passwd',
      'a/../../b.yaml',
      'a\\b.yaml',
      '.git/config',
      'C:/x',
      '~/x',
      'a//b.yaml',
      '../../../etc/passwd',
    ])
      expect(
        refusal(() => resolveContractRef(root, `contracts:${path}#/a`)).kind,
        path,
      ).toBe('path_not_contained');
  });

  it('refuses a ref to a link, and a root of another purpose', () => {
    const dir = tmp();
    const outside = tmp();
    put(outside, 'form.html', FORM(5));
    symlinkSync(join(outside, 'form.html'), join(dir, 'form.html'));
    expect(
      refusal(() =>
        resolveContractRef(
          openRoot(dir, 'contracts'),
          'contracts:form.html#/input/reason/maxlength',
        ),
      ).rule,
    ).toBe('no symbolic link');
    expect(
      refusal(() =>
        resolveContractRef(openRoot(dir, 'specs'), 'contracts:form.html#/a'),
      ).rule,
    ).toBe('purpose');
  });
});
