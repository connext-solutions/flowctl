import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.js';
import { RunError } from '../src/run/index.js';
import { observe } from '../src/observe/index.js';
import { initTrust, TrustStore } from '../src/trust/index.js';
import { gitRepo, testAnchorDir, testOwnerKey } from './trust-fixture.js';

/**
 * What a crawl refuses before any browser starts (ADR 0033): a production env, whose read-only replay rules (ADR 0024
 * section 2a) are stricter than the crawl's request layer.
 */
describe('observe checks', () => {
  it('never crawls an env the trust store classes production', async () => {
    const base = mkdtempSync(join(tmpdir(), 'flowctl-observe-plan-'));
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
          stg: { origin: 'https://stg.example.com', class: 'shared' },
          prod: { origin: 'https://app.example.com', class: 'production' },
        },
        productionOrigins: ['https://app.example.com'],
        defaultEnv: 'stg',
        language: 'vi',
        locale: 'vi-VN',
      },
      anchorDir: testAnchorDir(),
    });
    const cfg = parseConfig(
      {
        defaultEnv: 'stg',
        envs: {
          stg: { baseUrl: 'https://stg.example.com' },
          prod: { baseUrl: 'https://app.example.com' },
        },
        profiles: { employee: {} },
      },
      root,
    );
    const got = await observe(cfg, {
      env: 'prod',
      store: TrustStore.open(dir),
    }).catch((e: unknown) => e);
    expect(got).toBeInstanceOf(RunError);
    expect(got).toMatchObject({ kind: 'scope_violation' });
    expect(String(got)).toMatch(/never crawls a production env/);
  });
});
