import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rawStore } from './trust-fixture.js';
import {
  checkHookConsent,
  createHookConsent,
  createOwnerKey,
  type HookRequest,
  type OwnerKey,
  TrustError,
  TrustStore,
} from '../src/trust/index.js';

/**
 * C4 of T1.0: hook consent in the store (ADR 0025 section 5, ADR 0021 Amendment 2026-11-01 sections 1 and
 * 2.8, Amendment 2026-11-02 section 12 items 9 and 10). The env rules are in `trust-consent-env.test.ts`.
 */
let base: string;
let key: OwnerKey;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'flowctl-consent-'));
  key = createOwnerKey(join(base, 'keys'), 'correct horse battery staple');
}, 60_000);
afterAll(() => rmSync(base, { recursive: true, force: true }));

type Stored = { value: Record<string, unknown>; sig: string };

let n = 0;
/** A fresh flows root with `seed.sh`, and a store holding `hooks` (optionally marked `ci`). */
function setup(hooks: Record<string, unknown>, ci = false) {
  const dir = mkdtempSync(join(base, `case${n++}-`));
  const root = join(dir, 'flows');
  const store = join(dir, 'store');
  mkdirSync(root);
  writeFileSync(join(root, 'seed.sh'), '#!/bin/sh\ntrue\n', { mode: 0o755 });
  rawStore(
    store,
    {
      v: 1,
      markers: ci ? ['test', 'ci'] : ['test'],
      ownerFingerprint: key.fingerprint,
      ownerPublicKey: key.publicKey.toString('base64'),
      hooks,
    },
    key,
  );
  return { root, open: () => TrustStore.open(store) };
}

const req = (root: string, over: Partial<HookRequest> = {}): HookRequest => ({
  project: 'demo',
  flow: 'leave-create',
  root,
  flowsRoot: 'flows',
  setup: './seed.sh',
  teardown: undefined,
  ...over,
});

const choices = (env: string[] = [], pins: Record<string, string> = {}) => ({
  env,
  pins,
  pgpass: null,
});

function consent(
  root: string,
  r: Partial<HookRequest> = {},
  env: string[] = [],
  pins: Record<string, string> = {},
): [string, Stored] {
  const c = createHookConsent(key, req(root, r), choices(env, pins));
  return [c.id, { value: c.value, sig: c.sig }];
}

describe('hook consent in the store', () => {
  it('lets a consented hook run and refuses a one-character edit', () => {
    const [id, e] = consent(setup({}).root);
    const t = setup({ [id]: e });
    expect(checkHookConsent(t.open(), req(t.root)).ok).toBe(true);
    expect(
      checkHookConsent(t.open(), req(t.root, { setup: './seed.sh ' })),
    ).toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('refuses after a script the hook calls is edited', () => {
    const [id, e] = consent(setup({}).root);
    const t = setup({ [id]: e });
    writeFileSync(join(t.root, 'seed.sh'), '#!/bin/sh\nfalse\n', {
      mode: 0o755,
    });
    expect(checkHookConsent(t.open(), req(t.root))).toEqual({
      ok: false,
      reason: 'digest_mismatch',
    });
  });

  it('refuses a flow with no entry, and passes a flow with no hooks', () => {
    const s = setup({});
    expect(checkHookConsent(s.open(), req(s.root))).toEqual({
      ok: false,
      reason: 'no_entry',
    });
    expect(
      checkHookConsent(s.open(), req(s.root, { setup: undefined })).ok,
    ).toBe(true);
  });

  it('ignores an entry with an uncovered list in a ci store, and honours it elsewhere', () => {
    const r = { setup: './seed.sh && python3 -c x' };
    const [id, e] = consent(setup({}).root, r);
    const local = setup({ [id]: e });
    const ci = setup({ [id]: e }, true);
    expect(checkHookConsent(local.open(), req(local.root, r)).ok).toBe(true);
    expect(checkHookConsent(ci.open(), req(ci.root, r))).toEqual({
      ok: false,
      reason: 'hook_uncovered',
    });
  });

  it('refuses a ci run when the closure becomes uncovered with the files unchanged', () => {
    const r = { setup: './dash.sh' };
    const s = setup({});
    writeFileSync(join(s.root, 'dash.sh'), '#!/bin/dash\ntrue\n');
    const c = createHookConsent(
      key,
      req(s.root, { ...r, interpreterOk: () => true }),
      choices(),
    );
    const ci = setup({ [c.id]: { value: c.value, sig: c.sig } }, true);
    writeFileSync(join(ci.root, 'dash.sh'), '#!/bin/dash\ntrue\n');
    const run = (ok: boolean) =>
      checkHookConsent(
        ci.open(),
        req(ci.root, { ...r, interpreterOk: () => ok }),
      );
    expect(run(true).ok).toBe(true);
    expect(run(false)).toEqual({ ok: false, reason: 'digest_mismatch' });
  });

  it('refuses an entry edited by hand: a refused env name, and a changed pin', () => {
    const [id, e] = consent(setup({}).root, {}, ['PGHOST'], {
      PGHOST: 'db.local',
    });
    for (const change of [
      { env: ['PYTHONPATH'] },
      { pins: { PGHOST: 'attacker.example' } },
    ]) {
      const forged = setup({
        [id]: { ...e, value: { ...e.value, ...change } },
      });
      expect(() => checkHookConsent(forged.open(), req(forged.root))).toThrow(
        TrustError,
      );
    }
    const signedBad = { ...e.value, env: ['PYTHONPATH'] };
    const resigned = setup({
      [id]: {
        value: signedBad,
        sig: key.signEntry({ id, kind: 'hooks', value: signedBad }),
      },
    });
    expect(checkHookConsent(resigned.open(), req(resigned.root))).toEqual({
      ok: false,
      reason: 'hook_env_unsafe',
      detail: 'env_name_refused',
      name: 'PYTHONPATH',
    });
  });

  it('binds pins into the digest', () => {
    const root = setup({}).root;
    const a = consent(root, {}, ['PGHOST'], { PGHOST: 'db.local' })[1];
    const b = consent(root, {}, ['PGHOST'], { PGHOST: 'db.other' })[1];
    expect(a.value.digest).not.toBe(b.value.digest);
  });

  it('refuses to create a consent it cannot bind or show', () => {
    const root = setup({}).root;
    const bad: [
      Partial<HookRequest>,
      (
        | ReturnType<typeof choices>
        | { env: string[]; pins: Record<string, string>; pgpass: string }
      ),
    ][] = [
      [{ setup: 'echo a\r' }, choices()],
      [{ project: 'a/b' }, choices()],
      [{ flow: 'Leave' }, choices()],
      [{}, { env: [], pins: {}, pgpass: 'home/.pgpass' }],
      [{}, choices(['PGPASSWORD'], { PGPASSWORD: 'secret' })],
    ];
    for (const [r, c] of bad)
      expect(() => createHookConsent(key, req(root, r), c)).toThrow(TrustError);
  });
});
