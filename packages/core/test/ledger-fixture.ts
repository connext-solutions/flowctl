import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { type LoadedConfig, resolveEnv } from '../src/config.js';
import type { Flow } from '../src/flow/index.js';
import { confirmInputFor, confirmReadContext } from '../src/run/index.js';
import {
  type ConfirmEntry,
  initTrust,
  latestExpiry,
  planConfirm,
  saveConfirmEntries,
  TrustStore,
} from '../src/trust/index.js';
import { fixtureConfig, seedProfiles } from './helpers.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/** Shared pieces of the run ledger's browser tests: the fixture's items API, a `shared` test store, entries. */
const COOKIE = { cookie: 'role=employee', 'content-type': 'application/json' };

/** The fixture items app at `url`, and a project on it whose env `local` the test store classes `shared`. */
export class LedgerApp {
  constructor(readonly url: string) {}

  /** The names of the items the app holds now. */
  async items(): Promise<string[]> {
    const r = await fetch(`${this.url}/api/items`, { headers: COOKIE });
    const body: unknown = await r.json();
    if (
      typeof body !== 'object' ||
      body === null ||
      !('items' in body) ||
      !Array.isArray(body.items)
    )
      return [];
    return body.items.map((i: unknown) =>
      typeof i === 'object' && i !== null && 'name' in i ? String(i.name) : '?',
    );
  }

  /** Sets the id the next create returns. */
  async nextId(id: string): Promise<void> {
    await fetch(`${this.url}/api/__items/next`, {
      method: 'POST',
      headers: COOKIE,
      body: JSON.stringify({ id }),
    });
  }

  /** Creates an item outside any run. */
  async seed(name: string, id?: string): Promise<void> {
    if (id !== undefined) await this.nextId(id);
    const r = await fetch(`${this.url}/api/items`, {
      method: 'POST',
      headers: COOKIE,
      body: JSON.stringify({ name }),
    });
    expect(r.status).toBe(201);
  }

  /** A config with saved sessions and an empty test store that classes the fixture's origin `shared`. */
  async setup(): Promise<{ cfg: LoadedConfig; store: TrustStore }> {
    const cfg = fixtureConfig(this.url);
    await seedProfiles(cfg, this.url);
    const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-ledger-')), 's');
    gitRepo(cfg.root);
    initTrust({
      storeDir: dir,
      key: testOwnerKey(),
      project: 'ledger',
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      answers: {
        envs: { local: { origin: new URL(this.url).origin, class: 'shared' } },
        productionOrigins: [],
        defaultEnv: 'local',
        language: 'vi',
        locale: 'vi-VN',
      },
      anchorDir: testAnchorDir(),
    });
    return { cfg, store: TrustStore.open(dir) };
  }

  /**
   * Confirms `flow` as the owner would: a create entry with its cleanup and a delete entry bound to it.
   *
   * @returns the store opened again, holding the entries.
   */
  confirm(cfg: LoadedConfig, store: TrustStore, flow: Flow): TrustStore {
    const base = {
      env: 'local',
      origin: new URL(this.url).origin,
      expires: latestExpiry(new Date()),
      flow: flow.name,
      hash: planConfirm(confirmInputFor(cfg, flow, resolveEnv(cfg, 'local')))
        .digest,
      queryKeys: [],
    };
    const entries: ConfirmEntry[] = [
      {
        ...base,
        id: `${flow.name}-create`,
        kind: 'create',
        method: 'POST',
        template: '/api/items',
        contentType: 'json',
        bodyKeys: ['/name'],
        idFrom: 'body:/id',
        nameField: '/name',
        prefix: 'QA-',
        naturalKeys: ['/name'],
        conflictStatus: [409],
        cleanup: {
          method: 'DELETE',
          template: '/api/items/{uuid}',
          verify: { template: '/api/items/{uuid}' },
        },
      },
      {
        ...base,
        id: `${flow.name}-delete`,
        kind: 'mutate',
        method: 'DELETE',
        template: '/api/items/{uuid}',
        bodyKeys: [],
        ledgerFrom: `${flow.name}-create`,
        idPositions: ['path'],
      },
    ];
    saveConfirmEntries(store, testOwnerKey(), entries, confirmReadContext(cfg));
    return TrustStore.open(store.dir);
  }
}

/** A flow on `/items` that types `QA-{{uid}}` as the name; its one assertion is the create's 201. */
export const crud = (
  name: string,
  steps: unknown[],
  start = '/items',
): Record<string, unknown> & { name: string } => ({
  name,
  goal: 'Tạo rồi xoá một mục',
  profile: 'employee',
  start,
  inputs: { ten: { value: 'QA-{{uid}}' } },
  steps,
  assertions: [
    { network: { method: 'POST', url: '**/api/items', status: 201 } },
  ],
});

export const CREATE_STEPS = [
  { fill: { role: 'textbox', name: 'Tên mục' }, input: 'ten' },
  { click: { role: 'button', name: 'Tạo' } },
  { wait: 200 },
];
export const DELETE_STEP = {
  click: { role: 'button', name: 'Xoá QA-{{uid}}' },
};

/** The kinds of the lines of a run's ledger, with the result of a cleanup line (`cleanup:confirmed`). */
export const ledgerLines = (store: TrustStore, runId: string): string[] =>
  readFileSync(join(store.dir, 'ledgers', `${runId}.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map((l) => {
      const v: unknown = JSON.parse(l);
      const kind =
        typeof v === 'object' && v !== null && 'kind' in v
          ? String(v.kind)
          : '?';
      return typeof v === 'object' && v !== null && 'result' in v
        ? `${kind}:${String(v.result)}`
        : kind;
    });
