import { mkdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkEnvInputs } from '../src/run/env-inputs.js';
import {
  TrustError,
  TrustStore,
  addProfileEnvVar,
  allowedEnvVar,
} from '../src/trust/index.js';
import {
  allowEnvVars,
  editStore,
  testOwnerKey,
  testStore,
} from './trust-fixture.js';
import { fixtureConfig } from './helpers.js';

const cfg = () => {
  const c = fixtureConfig('http://127.0.0.1:1');
  mkdirSync(c.flowsPath, { recursive: true });
  return c;
};

const flow = (inputs: Record<string, { env: string } | { value: string }>) => ({
  name: 'f',
  profile: 'employee',
  inputs,
});

const kindOf = (f: () => void): unknown => {
  try {
    f();
  } catch (e) {
    return e instanceof TrustError ? e.kind : e;
  }
  return undefined;
};

describe('profile env-var allowlist (T1.14, issue #41)', () => {
  it('allows only names the owner added for that profile, matched case-insensitively', () => {
    const store = allowEnvVars(testStore(cfg()), 'employee', ['QA_PASSWORD']);
    expect(allowedEnvVar(store, 'employee', 'qa_password')).toEqual({
      name: 'QA_PASSWORD',
      kind: 'secret',
    });
    expect(allowedEnvVar(store, 'employee', 'QA_PASSWORD_2')).toBeUndefined();
    expect(allowedEnvVar(store, 'manager', 'QA_PASSWORD')).toBeUndefined();
  });

  it('refuses wildcards, a bare *, and a name already listed in any case', () => {
    const store = allowEnvVars(testStore(cfg()), 'employee', ['QA_USER']);
    for (const name of ['*', 'QA_*', 'A B', '1X', ''])
      expect(
        kindOf(() =>
          addProfileEnvVar(store, testOwnerKey(), 'employee', {
            name,
            kind: 'secret',
          }),
        ),
      ).toBe('trust_entry_invalid');
    expect(
      kindOf(() =>
        addProfileEnvVar(store, testOwnerKey(), 'employee', {
          name: 'qa_user',
          kind: 'username',
        }),
      ),
    ).toBe('trust_entry_invalid');
  });

  it('treats an edited profile entry as tampered', () => {
    const store = allowEnvVars(testStore(cfg()), 'employee', ['QA_USER']);
    editStore(store.dir, (d) => {
      d.profiles['employee']?.envVars.push({
        name: 'AWS_SECRET',
        kind: 'secret',
      });
      return d;
    });
    expect(
      kindOf(() =>
        allowedEnvVar(TrustStore.open(store.dir), 'employee', 'AWS_SECRET'),
      ),
    ).toBe('trust_tampered');
  });
});

describe('checkEnvInputs', () => {
  it('passes a flow without env inputs without opening any store', () => {
    expect(() =>
      checkEnvInputs(flow({ a: { value: 'x' } }), 'default'),
    ).not.toThrow();
  });

  it('refuses a name the profile does not allow, and says how to allow it', () => {
    const store = allowEnvVars(testStore(cfg()), 'employee', ['QA_PASSWORD']);
    expect(
      checkEnvInputs(
        flow({ pw: { env: 'qa_password' }, a: { value: 'x' } }),
        store,
      ),
    ).toEqual({ pw: { env: 'QA_PASSWORD' }, a: { value: 'x' } });
    let err: unknown;
    try {
      checkEnvInputs(flow({ key: { env: 'TYPESAFE_API_KEY' } }), store);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'env_not_allowed' });
    expect(err instanceof Error ? err.message : '').toContain(
      'flowctl trust add profile employee TYPESAFE_API_KEY secret',
    );
  });

  it('names the trust error when the store is tampered', () => {
    const store = allowEnvVars(testStore(cfg()), 'employee', ['QA_USER']);
    editStore(store.dir, (d) => {
      const v = d.profiles['employee']?.envVars[0];
      if (v !== undefined) v.name = 'GH_TOKEN';
      return d;
    });
    let err: unknown;
    try {
      checkEnvInputs(
        flow({ t: { env: 'GH_TOKEN' } }),
        TrustStore.open(store.dir),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({ kind: 'env_not_allowed' });
    expect(err instanceof Error ? err.message : '').toContain('trust_tampered');
  });
});
