import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { handWrittenDigest } from '../src/provenance/index.js';
import { replayFlow } from '../src/replay.js';
import { TrustStore } from '../src/trust/store.js';
import { fixtureConfig, seedProfiles, writeFlow } from './helpers.js';
import { editStore, testStore } from './trust-fixture.js';

let fixture: Fixture;
let browser: Browser;

beforeAll(async () => {
  fixture = await startFixture();
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
  await fixture.close();
});

async function ready() {
  const cfg = fixtureConfig(fixture.url);
  await seedProfiles(cfg, fixture.url);
  return cfg;
}

const doc = (over: Record<string, unknown> = {}) => ({
  name: 'prov',
  goal: 'g',
  profile: 'employee',
  start: '/requests',
  steps: [{ click: { role: 'button', name: 'Gửi' } }],
  assertions: [{ text: 'Vui lòng nhập lý do' }],
  ...over,
});

const runJson = (dir: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));

describe('provenance label on a replay', () => {
  it('labels a flow nobody classified unclassified, in the result and in run.json', async () => {
    const cfg = await ready();
    const r = await replayFlow(cfg, writeFlow(cfg, doc()), {
      browser,
      store: testStore(cfg),
    });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
    expect(r.provenance).toBe('unclassified');
    expect(r.provenanceNotes).toEqual([
      'freshness_not_checked',
      'rollback_not_checked',
    ]);
    const disk = runJson(r.evidence.dir);
    expect(disk.provenance).toBe('unclassified');
    expect(disk.provenanceNotes).toEqual(r.provenanceNotes);
  });

  it('labels a flow the store lists with its closure digest hand-written', async () => {
    const cfg = await ready();
    const flow = writeFlow(cfg, doc());
    const store = testStore(cfg);
    const entry = {
      path: 'prov.yaml',
      closureDigest: handWrittenDigest(flow, cfg.flowsPath),
    };
    editStore(store.dir, (d) => ({ ...d, handWritten: [entry] }));
    const r = await replayFlow(cfg, flow, {
      browser,
      store: TrustStore.open(store.dir),
    });
    expect(r.status).toBe('passed');
    expect(r.provenance).toBe('hand-written');
    expect(runJson(r.evidence.dir).provenance).toBe('hand-written');
  });

  it('labels a flow that claims a derivation unverified, even when the store lists it', async () => {
    const cfg = await ready();
    const flow = writeFlow(
      cfg,
      doc({
        derived: true,
        assertions: [
          {
            text: 'Vui lòng nhập lý do',
            sourceRef: { kind: 'contract', ref: 'c1', quote: 'a {{ b' },
          },
        ],
      }),
    );
    const store = testStore(cfg);
    const entry = {
      path: 'prov.yaml',
      closureDigest: handWrittenDigest(flow, cfg.flowsPath),
    };
    editStore(store.dir, (d) => ({ ...d, handWritten: [entry] }));
    const r = await replayFlow(cfg, flow, {
      browser,
      store: TrustStore.open(store.dir),
    });
    expect(r.status, JSON.stringify(r.failed ?? r.error)).toBe('passed');
    expect(r.provenance).toBe('unverified');
    expect(r.provenanceNotes).toContain('signature_unavailable');
  });

  it('never changes the verdict: a failing assertion fails under every label, and never echoes the quote', async () => {
    const cfg = await ready();
    const plain = await replayFlow(
      cfg,
      writeFlow(cfg, doc({ assertions: [{ text: 'nonexistent text' }] })),
      { browser, store: testStore(cfg) },
    );
    const derived = await replayFlow(
      cfg,
      writeFlow(
        cfg,
        doc({
          derived: true,
          assertions: [
            {
              text: 'nonexistent text',
              sourceRef: { kind: 'baseline', ref: 'b1', quote: 'SECRET-QUOTE' },
            },
          ],
        }),
      ),
      { browser, store: testStore(cfg) },
    );
    expect(plain.status).toBe('failed');
    expect(derived.status).toBe('failed');
    expect(plain.provenance).not.toBe(derived.provenance);
    expect(JSON.stringify(derived)).not.toContain('SECRET-QUOTE');
    expect(
      readFileSync(join(derived.evidence.dir, 'run.json'), 'utf8'),
    ).not.toContain('SECRET-QUOTE');
  });
});
