import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import type { LoadedConfig } from '../src/config.js';
import { planDestructive, planRenew } from '../src/run/index.js';
import { confirmReadContext } from '../src/run/index.js';
import {
  entryOf,
  initTrust,
  type RecordedCall,
  recordedWrites,
  renewConfirmEntries,
  saveConfirmEntries,
  TrustStore,
} from '../src/trust/index.js';
import { fixtureConfig } from './helpers.js';
import { refusal } from './confirm-fixture.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/**
 * `trust add destructive --from-run` without a terminal (ADR 0024 section 5 and the amendment 2026-11-13): entries
 * are derived from a passing run on a `local` env, never typed; renewal keeps everything but `expires` and refuses a
 * changed flow.
 */
const DEV = 'http://127.0.0.1:5173';
const STG = 'https://stg.example.com';
const ID = 'b1b2c3d4-0000-4000-8000-00000000abcd';

const CALLS: RecordedCall[] = [
  { method: 'GET', url: `${DEV}/api/items`, status: 200 },
  {
    method: 'POST',
    url: `${DEV}/api/items`,
    status: 201,
    requestBody: { name: 'QA-ab12cd34' },
  },
  { method: 'DELETE', url: `${DEV}/api/items/${ID}`, status: 204 },
  { method: 'POST', url: 'https://cdn.example.com/beacon', status: 204 },
  { method: 'POST', url: `${DEV}/api/items/${ID}/approve`, status: 200 },
];

function project(): { cfg: LoadedConfig; store: TrustStore } {
  const cfg = fixtureConfig(DEV, {
    envs: {
      dev: { baseUrl: DEV, loginUrl: '/login' },
      stg: { baseUrl: STG, loginUrl: '/login' },
    },
    defaultEnv: 'dev',
  });
  mkdirSync(cfg.flowsPath, { recursive: true });
  gitRepo(cfg.root);
  const dir = join(
    mkdtempSync(join(tmpdir(), 'flowctl-add-destructive-')),
    's',
  );
  initTrust({
    storeDir: dir,
    key: testOwnerKey(),
    project: 'add-destructive',
    projectDir: cfg.root,
    flowsDir: cfg.flowsPath,
    answers: {
      envs: {
        dev: { origin: DEV, class: 'local' },
        stg: { origin: STG, class: 'shared' },
      },
      productionOrigins: [],
      defaultEnv: 'dev',
      language: 'vi',
      locale: 'vi-VN',
    },
    anchorDir: testAnchorDir(),
  });
  writeFlow(cfg, 'Tạo rồi xoá');
  return { cfg, store: TrustStore.open(dir) };
}

function writeFlow(
  cfg: LoadedConfig,
  goal: string,
  extra: Record<string, unknown> = {},
): void {
  writeFileSync(
    join(cfg.flowsPath, 'items-crud.yaml'),
    stringify({
      name: 'items-crud',
      goal,
      profile: 'employee',
      start: '/items',
      inputs: { ten: { value: 'QA-{{uid}}' }, ...extra },
      steps: [{ click: { role: 'button', name: 'Tạo' } }],
      assertions: [
        { network: { method: 'POST', url: '**/api/items', status: 201 } },
      ],
    }),
  );
}

function recordRun(
  cfg: LoadedConfig,
  run: Record<string, unknown>,
  id = 'r_rec01',
): string {
  const dir = join(cfg.flowsPath, '.runs', id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({
      flow: 'items-crud',
      env: 'dev',
      status: 'passed',
      ...run,
    }),
  );
  writeFileSync(join(dir, 'network.json'), JSON.stringify(CALLS));
  return id;
}

describe('recordedWrites', () => {
  it('turns each write to the origin into a template with its body keys, and lists the others', () => {
    const { writes, skipped } = recordedWrites(CALLS, DEV);
    expect(
      writes.map(
        (w) =>
          `${w.method} ${w.template} ${w.contentType ?? '-'} ${w.bodyKeys.join(',')}`,
      ),
    ).toEqual([
      'POST /api/items json /name',
      'DELETE /api/items/{uuid} - ',
      'POST /api/items/{uuid}/approve - ',
    ]);
    expect(skipped.map((s) => s.request)).toEqual(['POST /beacon']);
  });
});

describe('planDestructive', () => {
  it('proposes a create with its cleanup and a delete bound to it, and the owner defaults become valid entries', () => {
    const { cfg, store } = project();
    const p = planDestructive(cfg, store, {
      flow: 'items-crud',
      env: 'stg',
      fromRun: recordRun(cfg, {}),
    });
    expect(p.base).toMatchObject({
      env: 'stg',
      origin: STG,
      flow: 'items-crud',
    });
    expect(p.base.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(p.files.map((f) => f.path)).toEqual(['items-crud.yaml']);
    expect(p.drafts.map((d) => `${d.kind} ${d.id}`)).toEqual([
      'create items-crud-create',
      'mutate items-crud-delete',
      'skip items-crud-post',
    ]);
    const [create, del] = p.drafts;
    expect(create).toMatchObject({
      nameField: '/name',
      idFrom: 'body:/id',
      cleanup: '/api/items/{uuid}',
    });
    expect(del?.ledgerFrom).toBe('items-crud-create');
    const entries = p.drafts
      .map((d) => entryOf(d, p.base))
      .filter((e) => e !== undefined);
    saveConfirmEntries(store, testOwnerKey(), entries, confirmReadContext(cfg));
  });

  it('refuses a run of another flow, on a shared env, or that did not pass, and an unconfirmable flow', () => {
    const { cfg, store } = project();
    const plan = (run: Record<string, unknown>): string =>
      refusal(() =>
        planDestructive(cfg, store, {
          flow: 'items-crud',
          env: 'stg',
          fromRun: recordRun(cfg, run),
        }),
      );
    expect(plan({ flow: 'other' })).toContain('a run of "other"');
    expect(plan({ env: 'stg' })).toContain('classed shared');
    expect(plan({ status: 'failed' })).toContain('did not pass');
    writeFlow(cfg, 'Tạo', { pass: { env: 'QA_PASSWORD' } });
    expect(plan({})).toContain('unconfirmable');
  });

  it('refuses --days that is not a whole number from 1 to 90', () => {
    const { cfg, store } = project();
    const fromRun = recordRun(cfg, {});
    for (const days of [Number('abc'), 0, -1, 200, 1.5])
      expect(
        refusal(() =>
          planDestructive(cfg, store, {
            flow: 'items-crud',
            env: 'stg',
            fromRun,
            days,
          }),
        ),
        String(days),
      ).toMatch(/^trust_entry_invalid: --days is a whole number from 1 to 90/);
  });
});

describe('entryOf', () => {
  it('refuses a create on a write that is not a POST, and a mutate on a POST', () => {
    const { cfg, store } = project();
    const p = planDestructive(cfg, store, {
      flow: 'items-crud',
      env: 'stg',
      fromRun: recordRun(cfg, {}),
    });
    const [create, del, approve] = p.drafts;
    if (create === undefined || del === undefined || approve === undefined)
      throw new Error('three drafts');
    expect(refusal(() => entryOf({ ...del, kind: 'create' }, p.base))).toMatch(
      /^trust_entry_invalid: .*DELETE/,
    );
    expect(
      refusal(() => entryOf({ ...approve, kind: 'mutate' }, p.base)),
    ).toMatch(/^trust_entry_invalid: .*POST/);
    expect(entryOf(approve, p.base)).toBeUndefined();
  });
});

describe('planRenew', () => {
  it('gives an unchanged flow a new expiry and nothing else, and refuses a changed one', () => {
    const { cfg, store } = project();
    const p = planDestructive(cfg, store, {
      flow: 'items-crud',
      env: 'stg',
      fromRun: recordRun(cfg, {}),
    });
    const entries = p.drafts
      .map((d) => entryOf(d, p.base))
      .filter((e) => e !== undefined);
    saveConfirmEntries(store, testOwnerKey(), entries, confirmReadContext(cfg));
    const saved = TrustStore.open(store.dir);
    const [r] = planRenew(cfg, saved, { ids: ['items-crud-create'], days: 10 });
    expect(r?.next).toEqual({ ...r?.old, expires: r?.next.expires });
    expect(r?.next.expires).not.toBe(r?.old.expires);
    renewConfirmEntries(
      saved,
      testOwnerKey(),
      r === undefined ? [] : [r.next],
      confirmReadContext(cfg),
    );
    writeFlow(cfg, 'Đã sửa');
    expect(
      refusal(() =>
        planRenew(cfg, TrustStore.open(store.dir), {
          ids: ['items-crud-create'],
        }),
      ),
    ).toMatch(/^renew_digest_changed/);
    expect(refusal(() => planRenew(cfg, saved, { ids: ['nope'] }))).toContain(
      'no destructiveConfirm entry "nope"',
    );
  });
});
