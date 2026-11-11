import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fixtureConfig } from './helpers.js';
import {
  TrustError,
  TrustStore,
  addProfileEnvVar,
} from '../src/trust/index.js';
import {
  ANCHOR_BINARIES,
  chooseAnchor,
  readAnchor,
  writeAnchor,
} from '../src/trust/anchor.js';
import { editStore, testOwnerKey, testStore } from './trust-fixture.js';

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return `${e.kind}:${e.detail ?? ''}`;
    throw e;
  }
  return undefined;
};

const fresh = (): TrustStore => {
  const cfg = fixtureConfig('http://127.0.0.1:1');
  mkdirSync(cfg.flowsPath, { recursive: true });
  return testStore(cfg);
};

const allow = (store: TrustStore, name: string): void =>
  addProfileEnvVar(store, testOwnerKey(), 'employee', { name, kind: 'secret' });

const snapshot = (dir: string) => ({
  json: readFileSync(join(dir, 'trust.json'), 'utf8'),
  log: readFileSync(join(dir, 'trust.log'), 'utf8'),
});
const restore = (dir: string, s: { json: string; log: string }): void => {
  writeFileSync(join(dir, 'trust.json'), s.json, { mode: 0o600 });
  writeFileSync(join(dir, 'trust.log'), s.log, { mode: 0o600 });
};

describe('anchor, the second head (ADR 0025 Amendment 2026-11-02 section 7)', () => {
  it('is written at init, signed in trust.json, and follows every write', () => {
    const store = fresh();
    const anchor = store.anchor;
    expect(anchor.location.kind).toBe('file');
    expect(anchor.record.head).toBe(store.data.head);
    allow(store, 'QA_A');
    const after = TrustStore.open(store.dir);
    expect(readAnchor(anchor.location)).toMatchObject({
      head: after.data.head,
      pending: null,
    });
  });

  it('detects a rollback of trust.json and its log by one version', () => {
    const store = fresh();
    const before = snapshot(store.dir);
    allow(store, 'QA_B');
    restore(store.dir, before);
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:anchor_head_mismatch',
    );
  });

  it('refuses a store whose anchor is gone', () => {
    const store = fresh();
    const anchor = store.anchor;
    if (anchor.location.kind !== 'file') throw new Error('no file anchor');
    rmSync(anchor.location.locator);
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:anchor_unreachable',
    );
  });

  it('accepts the head of a write that crashed between its two phases, and the next write reconciles it', () => {
    const store = fresh();
    const anchor = store.anchor;
    writeAnchor(anchor.location, {
      ...anchor.record,
      pending: { head: 'f'.repeat(64), seq: 9 },
    });
    expect(TrustStore.open(store.dir).anchor.record.pending?.head).toBe(
      'f'.repeat(64),
    );
    allow(TrustStore.open(store.dir), 'QA_C');
    const after = TrustStore.open(store.dir);
    expect(after.anchor.record).toMatchObject({
      head: after.data.head,
      pending: null,
    });
  });

  it('chooses a file anchor only outside the store, from an absolute --anchor-dir', () => {
    const base = mkdtempSync(join(tmpdir(), 'flowctl-anchor-choose-'));
    const storeDir = join(base, 'store');
    const id = '00000000-0000-4000-8000-000000000000';
    expect(kindOf(() => chooseAnchor(id, storeDir, 'relative/dir'))).toBe(
      'trust_entry_invalid:',
    );
    expect(kindOf(() => chooseAnchor(id, storeDir, join(storeDir, 'a')))).toBe(
      'trust_entry_invalid:',
    );
    const loc = chooseAnchor(id, storeDir, join(base, 'anchors'));
    expect(loc).toEqual({
      kind: 'file',
      locator: join(realpathSync(base), 'anchors', `${id}.anchor`),
    });
  });
});

describe('anchor: no downgrade and the commit branch', () => {
  it('refuses a store whose anchor entry was removed, even with its log rewritten to match', () => {
    const store = fresh();
    editStore(store.dir, (d) => {
      const { anchor: _gone, ...rest } = d;
      return rest;
    });
    expect(kindOf(() => TrustStore.open(store.dir))).toBe(
      'trust_tampered:anchor_head_mismatch',
    );
  });

  it('accepts a write whose trust.json landed but whose anchor was not committed, and the next write commits it', () => {
    const store = fresh();
    const before = store.data.head;
    allow(store, 'QA_D');
    const now = TrustStore.open(store.dir);
    const head = now.data.head;
    if (before === undefined || head === undefined) throw new Error('no head');
    writeAnchor(now.anchor.location, {
      ...now.anchor.record,
      head: before,
      seq: now.anchor.record.seq - 1,
      pending: { head, seq: now.anchor.record.seq },
    });
    expect(TrustStore.open(store.dir).anchor.record.pending?.head).toBe(head);
    allow(TrustStore.open(store.dir), 'QA_E');
    const after = TrustStore.open(store.dir);
    expect(after.anchor.record).toMatchObject({
      head: after.data.head,
      pending: null,
    });
  });
});

describe('anchor backends through a fake keychain (never the real one)', () => {
  const saved = { ...ANCHOR_BINARIES };
  afterEach(() => Object.assign(ANCHOR_BINARIES, saved));

  /** A fake `security`: items are files in `items/`; `fail` makes every call exit 1. */
  function fakeSecurity(fail = false): string {
    const dir = mkdtempSync(join(tmpdir(), 'flowctl-fake-kc-'));
    const items = join(dir, 'items');
    mkdirSync(items);
    const bin = join(dir, 'security');
    writeFileSync(
      bin,
      fail
        ? '#!/bin/sh\nexit 1\n'
        : `#!/bin/sh
cmd="$1"; shift
acct=""; pw=""
while [ $# -gt 0 ]; do
  case "$1" in
    -a) acct="$2"; shift 2;;
    -w) if [ $# -ge 2 ]; then pw="$2"; shift 2; else shift; fi;;
    *) shift;;
  esac
done
case "$cmd" in
  add-generic-password) printf '%s' "$pw" > "${items}/$acct";;
  find-generic-password) [ -f "${items}/$acct" ] || exit 44; cat "${items}/$acct";;
  *) exit 2;;
esac
`,
      { mode: 0o755 },
    );
    return bin;
  }

  it('picks the keychain when it answers, and reports a missing item as anchor_unreachable with the cause', () => {
    ANCHOR_BINARIES.security = fakeSecurity();
    ANCHOR_BINARIES.secretTool = '/nonexistent/secret-tool';
    const id = '22222222-3333-4444-8555-666666666666';
    const loc = chooseAnchor(id, '/tmp/flowctl-no-store');
    expect(loc).toEqual({ kind: 'keychain', locator: id });
    const rec = readAnchor(loc);
    expect(rec.storeId).toBe(id);
    let err: unknown;
    try {
      readAnchor({
        kind: 'keychain',
        locator: '33333333-3333-4333-8333-333333333333',
      });
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      kind: 'trust_tampered',
      detail: 'anchor_unreachable',
    });
    expect(err instanceof Error ? err.message : '').toContain('exited 44');
  });

  it('refuses init with no keychain that answers and no --anchor-dir (owner decision 2026-11-06)', () => {
    ANCHOR_BINARIES.security = fakeSecurity(true);
    ANCHOR_BINARIES.secretTool = '/nonexistent/secret-tool';
    expect(
      kindOf(() =>
        chooseAnchor('44444444-4444-4444-8444-444444444444', '/tmp/x-store'),
      ),
    ).toBe('anchor_unavailable:');
  });
});
