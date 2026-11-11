import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupRun } from '../src/run/index.js';
import { LedgerFile } from '../src/trust/index.js';
import { writeFlow } from './helpers.js';
import {
  CREATE_STEPS,
  crud,
  LedgerApp,
  ledgerLines,
} from './ledger-fixture.js';

/**
 * `cleanupRun` (`flowctl cleanup <run id>`, ADR 0024 section 5 rule 10 and the amendment 2026-11-12): a crashed
 * run's ledger is cleaned from the store, an unanswered create is reported by name and never deleted by it, and a
 * second cleanup sends nothing for ids already confirmed.
 */
let fixture: Fixture;
let app: LedgerApp;
beforeAll(async () => {
  fixture = await startFixture();
  app = new LedgerApp(fixture.url);
});
afterAll(() => fixture.close());
beforeEach(async () => {
  await fetch(`${fixture.url}/api/__reset`, { method: 'POST' });
});

describe('cleanupRun', () => {
  const LOCK_ID = 'e1b2c3d4-0000-4000-8000-00000000abcd';
  it('cleans a crashed run from its ledger, reports an unanswered create by name, and sends nothing the second time', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-crash', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const id = 'b1b2c3d4-0000-4000-8000-00000000abcd';
    await app.seed('QA-crash', id);
    await app.seed('QA-lost');
    const runId = 'r_crash01';
    const f = LedgerFile.create(store.dir, runId, null);
    f.append({
      kind: 'intent',
      seq: 1,
      entry: 'items-crash-create',
      name: 'QA-crash',
    });
    f.append({ kind: 'id', seq: 1, entry: 'items-crash-create', id });
    f.append({
      kind: 'intent',
      seq: 2,
      entry: 'items-crash-create',
      name: 'QA-lost',
    });
    f.close();
    const first = await cleanupRun(cfg, runId, { store });
    expect(first.confirmed).toBe(1);
    expect(first.leftover).toEqual([
      {
        entry: 'items-crash-create',
        id: null,
        name: 'QA-lost',
        detail: 'create_unconfirmed',
      },
    ]);
    expect(await app.items()).toEqual(['QA-lost']);
    const lines = ledgerLines(store, runId);
    expect(lines.at(-1)).toBe('cleanup:confirmed');
    const second = await cleanupRun(cfg, runId, { store });
    expect(second.confirmed).toBe(0);
    expect(ledgerLines(store, runId)).toEqual(lines);
  });

  it('sends no request for a forged id that would leave the template, and leaves it id_invalid', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-forged', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const id = 'c1b2c3d4-0000-4000-8000-00000000abcd';
    await app.seed('QA-keep', id);
    const runId = 'r_forged01';
    const f = LedgerFile.create(store.dir, runId, null);
    for (const [seq, forged] of [
      `x/../${id}`,
      '$&',
      `../items/${id}`,
    ].entries()) {
      f.append({
        kind: 'intent',
        seq: seq + 1,
        entry: 'items-forged-create',
        name: 'QA-x',
      });
      f.append({
        kind: 'id',
        seq: seq + 1,
        entry: 'items-forged-create',
        id: forged,
      });
    }
    f.close();
    const r = await cleanupRun(cfg, runId, { store });
    expect(r.confirmed).toBe(0);
    expect(r.leftover.map((l) => l.detail)).toEqual([
      'id_invalid',
      'id_invalid',
      'id_invalid',
    ]);
    expect(await app.items()).toEqual(['QA-keep']);
  });

  it('refuses busy while the run holds the ledger, and one of two cleanups at once', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-lock', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const runId = 'r_lock01';
    const live = LedgerFile.create(store.dir, runId, null);
    await expect(cleanupRun(cfg, runId, { store })).rejects.toMatchObject({
      kind: 'ledgers_invalid',
      detail: 'busy',
    });
    live.close();
    await app.seed('QA-lock', LOCK_ID);
    const f = LedgerFile.open(store.dir, runId, null).file;
    f.append({
      kind: 'intent',
      seq: 1,
      entry: 'items-lock-create',
      name: 'QA-lock',
    });
    f.append({ kind: 'id', seq: 1, entry: 'items-lock-create', id: LOCK_ID });
    f.close();
    const both = await Promise.allSettled([
      cleanupRun(cfg, runId, { store }),
      cleanupRun(cfg, runId, { store }),
    ]);
    expect(both.map((b) => b.status).sort()).toEqual(['fulfilled', 'rejected']);
    const refused = both.find((b) => b.status === 'rejected');
    expect(refused?.reason).toMatchObject({ detail: 'busy' });
    expect(await app.items()).toEqual([]);
  });

  it('takes over a stale lock whose process is gone and notes it', async () => {
    const { cfg, store: empty } = await app.setup();
    const flow = writeFlow(cfg, crud('items-stale', CREATE_STEPS));
    const store = app.confirm(cfg, empty, flow);
    const runId = 'r_stale01';
    LedgerFile.create(store.dir, runId, null).close();
    const lock = join(store.dir, 'ledgers', `${runId}.lock`);
    writeFileSync(lock, `${spawnSync('true').pid}\n`, { mode: 0o600 });
    const r = await cleanupRun(cfg, runId, { store });
    expect(r).toEqual({ confirmed: 0, leftover: [], staleLock: true });
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses a run id that is not one', async () => {
    const { cfg, store } = await app.setup();
    for (const bad of ['../x', 'R_1', `r_${'a'.repeat(33)}`])
      await expect(cleanupRun(cfg, bad, { store })).rejects.toThrow(
        'is not a run id',
      );
  });
});
