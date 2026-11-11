import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type ConfirmEntry,
  type CreateConfirm,
  initTrust,
  type MutateConfirm,
  saveConfirmEntries,
  TrustStore,
} from '../src/trust/index.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/** Shared fixtures of the `destructiveConfirm` tests: a store with a shared and a production env, and one entry per kind. */
export const NOW = new Date('2026-11-13T10:00:00.000Z');
export const HASH = 'a'.repeat(64);
export const STG = 'https://stg.example.com';

export function store(): TrustStore {
  const base = mkdtempSync(join(tmpdir(), 'flowctl-confirm-'));
  const root = join(base, 'repo');
  mkdirSync(join(root, '.flows'), { recursive: true });
  gitRepo(root);
  const dir = join(base, 'store');
  initTrust({
    storeDir: dir,
    key: testOwnerKey(),
    project: 'demo',
    projectDir: root,
    flowsDir: join(root, '.flows'),
    answers: {
      envs: {
        stg: { origin: STG, class: 'shared' },
        prod: { origin: 'https://erp.example.com', class: 'production' },
      },
      productionOrigins: ['https://erp.example.com'],
      defaultEnv: 'stg',
      language: 'vi',
      locale: 'vi-VN',
    },
    anchorDir: testAnchorDir(),
  });
  return TrustStore.open(dir);
}

export const CREATE: CreateConfirm = {
  id: 'items-create',
  env: 'stg',
  origin: STG,
  expires: '2026-12-01',
  flow: 'items-crud',
  hash: HASH,
  kind: 'create',
  method: 'POST',
  template: '/api/items',
  contentType: 'json',
  bodyKeys: ['/name', '/code', '/lines/*/qty'],
  queryKeys: [],
  idFrom: 'body:/id',
  nameField: '/name',
  prefix: 'QA-',
  naturalKeys: ['/code'],
  conflictStatus: [409],
  cleanup: {
    method: 'DELETE',
    template: '/api/items/{int}',
    verify: { template: '/api/items/{int}' },
  },
};

export const MUTATE: MutateConfirm = {
  id: 'items-rename',
  env: 'stg',
  origin: STG,
  expires: '2026-12-01',
  flow: 'items-crud',
  hash: HASH,
  kind: 'mutate',
  method: 'PATCH',
  template: '/api/items/{int}',
  contentType: 'json',
  bodyKeys: ['/name'],
  queryKeys: [],
  ledgerFrom: 'items-create',
  idPositions: ['path'],
};

export const SESSION: Extract<ConfirmEntry, { kind: 'session' }> = {
  id: 'login',
  env: 'stg',
  origin: STG,
  expires: '2026-12-01',
  flow: 'items-crud',
  hash: HASH,
  kind: 'session',
  method: 'POST',
  template: '/api/login',
  contentType: 'json',
  bodyKeys: ['/user'],
  queryKeys: [],
};

export const denied = (path: string): boolean =>
  /\/(logout|sign-?out)$/.test(path);
export const ctx = { now: NOW, denied };

export const save = (s: TrustStore, entries: ConfirmEntry[]): void =>
  saveConfirmEntries(s, testOwnerKey(), entries, ctx);

export const refusal = (f: () => void): string => {
  try {
    f();
  } catch (e) {
    return e instanceof Error && 'kind' in e
      ? `${String(e.kind)}: ${e.message}`
      : String(e);
  }
  return 'accepted';
};
