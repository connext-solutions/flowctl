import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import {
  assertDriverFor,
  createDriver,
  type Driver,
} from '../src/system1/index.js';
import { JevDriver } from '../src/system1/jev.js';

/** Where a System 1 driver may be used (issues #14 and #15, ADR 0005, ADR 0022). */
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

const cfg = parseConfig(
  {
    defaultEnv: 'local',
    envs: {
      local: { baseUrl: 'http://local.test' },
      staging: { baseUrl: 'http://staging.test' },
    },
    profiles: {},
    system1: {
      baseUrl: 'https://jev.example',
      allowedEnvs: ['local', 'staging'],
    },
  },
  '/tmp',
);
const KEY = { TYPESAFE_API_KEY: 'k' };

describe('a driver is bound to the env createDriver checked it for (#15)', () => {
  it('accepts only that env', () => {
    const d = createDriver(cfg, 'staging', KEY);
    expect(() => assertDriverFor(d, 'staging')).not.toThrow();
    expect(thrown(() => assertDriverFor(d, 'local'))).toMatchObject({
      kind: 'system1_not_allowed',
    });
  });

  it('refuses a driver built directly, a look-alike object, and no driver', () => {
    const direct = new JevDriver({
      baseUrl: 'https://jev.example',
      apiKey: 'k',
    });
    const fake: Driver = {
      id: 'jev',
      decide: () => Promise.reject(new Error('never called')),
    };
    for (const d of [direct, fake, undefined])
      expect(thrown(() => assertDriverFor(d, 'local'))).toMatchObject({
        kind: 'system1_not_allowed',
      });
  });

  it('allows plain http only to this machine (#14)', () => {
    for (const baseUrl of [
      'http://localhost:4001',
      'http://127.0.0.1:9',
      'http://[::1]:9',
    ])
      expect(() => new JevDriver({ baseUrl, apiKey: 'k' })).not.toThrow();
  });
});
