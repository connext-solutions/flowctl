import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/index.js';
import {
  addSystem1,
  hostPortOf,
  planRotation,
  planSystem1,
  TrustError,
  TrustStore,
  trustedSystem1,
} from '../../src/trust/index.js';
import { editStore, testOwnerKey, testStore } from '../trust-fixture.js';

const BASE = {
  defaultEnv: 'local',
  envs: {
    local: { baseUrl: 'http://127.0.0.1:4200' },
    staging: { baseUrl: 'http://127.0.0.1:4300' },
  },
  profiles: { admin: {} },
  system1: {
    baseUrl: 'https://api.typesafe.ai',
    allowedEnvs: ['local', 'staging'],
  },
};

/** A store made from `BASE` with `system1` allowing `api.typesafe.ai:443`, `TYPESAFE_API_KEY` and env `local`. */
function store(): { store: TrustStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-s1-'));
  mkdirSync(join(root, '.flows'));
  const s = testStore(parseConfig(BASE, root));
  addSystem1(s, testOwnerKey(), {
    host: 'api.typesafe.ai:443',
    apiKeyEnv: 'TYPESAFE_API_KEY',
    envs: ['local'],
  });
  return { store: TrustStore.open(s.dir), root };
}

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return e.kind;
    throw e;
  }
  return undefined;
};

describe('the store system1 section (ADR 0025 section 2)', () => {
  it('writes a signed section that a rotation re-signs', () => {
    const { store: s } = store();
    expect(trustedSystem1(s)).toEqual({
      allowedHosts: ['api.typesafe.ai:443'],
      apiKeyEnvs: ['TYPESAFE_API_KEY'],
      allowedEnvs: ['local'],
    });
    expect(planRotation(s.dir).counts.system1).toBe(1);
  });

  it('refuses a section that is not owner-signed', () => {
    const { store: s } = store();
    editStore(s.dir, (d) =>
      d.system1 === undefined
        ? d
        : {
            ...d,
            system1: { ...d.system1, allowedHosts: ['evil.example:443'] },
          },
    );
    expect(kindOf(() => trustedSystem1(TrustStore.open(s.dir)))).toBe(
      'trust_tampered',
    );
  });

  it('accepts a bracketed IPv6 host, refuses a ci store, and keeps the first host when adding a second', () => {
    const { store: s } = store();
    expect(
      planSystem1(s, { host: '[::1]:8443', apiKeyEnv: 'K', envs: ['local'] })
        .after.allowedHosts,
    ).toEqual(['api.typesafe.ai:443', '[::1]:8443']);
    editStore(s.dir, (d) => ({ ...d, markers: ['ci'] }));
    expect(
      kindOf(() =>
        planSystem1(TrustStore.open(s.dir), {
          host: 'b.example:443',
          apiKeyEnv: 'K',
          envs: ['local'],
        }),
      ),
    ).toBe('trust_entry_invalid');
  });

  it('a test store allows only a loopback System 1 (ADR 0025 section 1)', () => {
    const { store: s } = store();
    editStore(s.dir, (d) => ({ ...d, markers: ['test'] }));
    const t = TrustStore.open(s.dir);
    const add = (host: string) => () =>
      planSystem1(t, { host, apiKeyEnv: 'K', envs: ['local'] });
    expect(kindOf(add('b.example:443'))).toBe('trust_entry_invalid');
    expect(kindOf(add('127.0.0.1:9000'))).toBeUndefined();
  });

  it('refuses a bad host, a bad key name, an unknown env and nothing new', () => {
    const { store: s } = store();
    const add = (host: string, apiKeyEnv: string, envs: string[]) => () =>
      planSystem1(s, { host, apiKeyEnv, envs });
    expect(kindOf(add('api.typesafe.ai', 'K', ['local']))).toBe(
      'trust_entry_invalid',
    );
    expect(kindOf(add('https://a:443', 'K', ['local']))).toBe(
      'trust_entry_invalid',
    );
    for (const bad of ['a.example:0', 'a.example:65536', 'a.example:443/p'])
      expect(kindOf(add(bad, 'K', ['local'])), bad).toBe('trust_entry_invalid');
    expect(kindOf(add('a.example:443', 'BAD-NAME', ['local']))).toBe(
      'trust_entry_invalid',
    );
    expect(kindOf(add('a.example:443', 'K', ['nope']))).toBe(
      'trust_entry_invalid',
    );
    expect(
      kindOf(add('api.typesafe.ai:443', 'TYPESAFE_API_KEY', ['local'])),
    ).toBe('trust_entry_invalid');
    expect(hostPortOf('https://API.typesafe.ai')).toBe('api.typesafe.ai:443');
  });
});
