import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunError } from '../src/foundation/index.js';
import {
  buildHookEnv,
  HookSession,
  computeClosure,
  createHookSnapshot,
  type HookConsent,
  type HookSnapshot,
  removeHookSnapshot,
  spawnHook,
  verifyHookSnapshot,
} from '../src/trust/index.js';

/**
 * C5 of T1.0: the hook snapshot and the built environment (ADR 0021 Amendment 2026-11-01 sections 2.7 and
 * 2.9, Amendment 2026-11-02 sections 2, 9, 10 and 12 items 2, 7, 9, 10).
 */
let root: string;
let snap: HookSnapshot | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowctl-hookrun-'));
  mkdirSync(join(root, 'lib'));
  writeFileSync(join(root, 'lib', 'seed.sh'), '#!/bin/sh\ntrue\n', {
    mode: 0o755,
  });
});
afterEach(() => {
  if (snap !== undefined) removeHookSnapshot(snap.dir);
  snap = undefined;
  rmSync(root, { recursive: true, force: true });
});

const entry = (over: Partial<HookConsent> = {}): HookConsent => ({
  project: 'p',
  flow: 'f',
  digest: '0'.repeat(64),
  env: [],
  pins: {},
  pgpass: null,
  uncovered: [],
  unbound: false,
  ...over,
});

function makeSnapshot(setup = './lib/seed.sh'): HookSnapshot {
  const s = createHookSnapshot(root, computeClosure({ root, setup }));
  if (typeof s === 'string') throw new Error(s);
  snap = s;
  return s;
}

describe('hook snapshot', () => {
  it('mirrors only closure files, 0500, in a 0700 directory with an empty scratch dir', () => {
    writeFileSync(join(root, 'other.sh'), 'true\n');
    const s = makeSnapshot();
    expect(statSync(s.dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(s.cwd, 'lib', 'seed.sh')).mode & 0o777).toBe(0o500);
    expect(statSync(join(s.cwd, 'lib')).mode & 0o777).toBe(0o500);
    expect(statSync(join(s.cwd, '.hook-tmp')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(s.cwd, '.hook-tmp'))).toEqual([]);
    expect(existsSync(join(s.cwd, 'other.sh'))).toBe(false);
  });

  it('detects a closure file changed after the snapshot', () => {
    const s = makeSnapshot();
    const file = join(s.cwd, 'lib', 'seed.sh');
    chmodSync(join(s.cwd, 'lib'), 0o700);
    chmodSync(file, 0o700);
    writeFileSync(file, '#!/bin/sh\nfalse\n');
    expect(verifyHookSnapshot(s)).toBe('snapshot_modified');
  });

  it('refuses to snapshot a file that changed since the closure', () => {
    const closure = computeClosure({ root, setup: './lib/seed.sh' });
    writeFileSync(join(root, 'lib', 'seed.sh'), '#!/bin/sh\nfalse\n');
    expect(createHookSnapshot(root, closure)).toBe('snapshot_unavailable');
  });

  it('removes the whole snapshot, sealed directories included', () => {
    const s = makeSnapshot();
    removeHookSnapshot(s.dir);
    expect(existsSync(s.dir)).toBe(false);
    snap = undefined;
  });
});

describe('hook environment', () => {
  const parent = {
    PATH: '/evil',
    HOME: '/x',
    TMPDIR: '/y',
    AWS_SECRET_ACCESS_KEY: 'a',
    TYPESAFE_API_KEY: 'k',
    PYTHONPATH: '/p',
    LANG: 'vi_VN.UTF-8',
    LC_ALL: 'ja_JP.SJIS',
    TZ: ':/etc/passwd',
    PGPASSWORD: 'pw',
    PGHOST: 'db.local',
  };

  it('is built from nothing: fixed PATH, HOME and TMPDIR in the snapshot, no parent secret', async () => {
    const s = makeSnapshot();
    const built = buildHookEnv(s, entry({ env: ['PGPASSWORD'] }), parent);
    if (!built.ok) throw new Error(built.detail);
    const env = built.env;
    expect(env.PATH).toBe('/usr/bin:/bin:/usr/sbin:/sbin');
    expect(env.HOME).toBe(s.home);
    expect(env.TMPDIR).toBe(s.tmp);
    expect(env.LANG).toBe('vi_VN.UTF-8');
    expect(env.PGPASSWORD).toBe('pw');
    for (const name of [
      'AWS_SECRET_ACCESS_KEY',
      'TYPESAFE_API_KEY',
      'PYTHONPATH',
      'LC_ALL',
      'TZ',
      'PGHOST',
    ])
      expect(env[name]).toBeUndefined();
    const r = await spawnHook('/usr/bin/env', s.cwd, env, 5000);
    expect(r.ok).toBe(true);
    expect(r.output).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(r.output).toContain(`HOME=${s.home}`);
  });

  it('passes a pinned value only when the parent matches it byte for byte', () => {
    const s = makeSnapshot();
    const pinned = entry({ env: ['PGHOST'], pins: { PGHOST: 'db.local' } });
    const ok = buildHookEnv(s, pinned, parent);
    expect(ok.ok && ok.env.PGHOST).toBe('db.local');
    for (const value of ['other', '', undefined]) {
      const r = buildHookEnv(s, pinned, { ...parent, PGHOST: value });
      expect(r).toEqual({
        ok: false,
        detail: 'env_value_mismatch',
        name: 'PGHOST',
      });
    }
  });
});

describe('hook session', () => {
  it('refuses hooks with no store, and an exploration draft, as no_entry', () => {
    const target = {
      projectDir: root,
      flowsDir: root,
      setup: 'true',
      teardown: undefined,
    };
    for (const flow of ['f', undefined]) {
      let caught: unknown;
      try {
        HookSession.prepare(undefined, { ...target, flow });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(RunError);
      expect(caught instanceof RunError ? caught.hint : '').toContain(
        'no_entry',
      );
    }
  });
});

describe('hook process', () => {
  it('kills the process group when the hook times out', async () => {
    const s = makeSnapshot();
    const t = Date.now();
    const r = await spawnHook(
      'sleep 6; echo done',
      s.cwd,
      { PATH: '/usr/bin:/bin' },
      300,
    );
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.ok).toBe(false);
    expect(r.output).toContain('timed out after 300ms');
  });

  it('does not wait for a background process after the hook exits', async () => {
    const s = makeSnapshot();
    const t = Date.now();
    const r = await spawnHook(
      '(sleep 5 &) ; exit 0',
      s.cwd,
      { PATH: '/usr/bin:/bin' },
      3000,
    );
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.ok).toBe(true);
  });
});
