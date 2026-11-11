import { describe, expect, it } from 'vitest';
import { System1Client } from '../src/system1/index.js';

/** Where a System 1 client may be used (issues #14 and #15, ADR 0005). */
const thrown = (f: () => unknown): unknown => {
  try {
    f();
  } catch (e) {
    return e;
  }
  return undefined;
};

describe('System1Client is bound to the env it was allowed for (#15)', () => {
  it('accepts only the env fromConfig checked, and refuses a client made directly', () => {
    const c = new System1Client({
      baseUrl: 'https://jev.example',
      apiKey: 'k',
      env: 'staging',
    });
    expect(() => c.assertFor('staging')).not.toThrow();
    expect(thrown(() => c.assertFor('production'))).toMatchObject({
      kind: 'system1_not_allowed',
    });
    expect(
      thrown(() =>
        new System1Client({
          baseUrl: 'https://jev.example',
          apiKey: 'k',
        }).assertFor('local'),
      ),
    ).toMatchObject({ kind: 'system1_not_allowed' });
  });

  it('allows plain http only to this machine (#14)', () => {
    for (const baseUrl of [
      'http://localhost:4001',
      'http://127.0.0.1:9',
      'http://[::1]:9',
    ])
      expect(() => new System1Client({ baseUrl, apiKey: 'k' })).not.toThrow();
  });
});
