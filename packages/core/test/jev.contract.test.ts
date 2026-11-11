import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import dayjs from 'dayjs';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runsPath, type LoadedConfig } from '../src/config.js';
import { Exploration, type ExploreStop } from '../src/explore/index.js';
import { saveExploration } from '../src/save.js';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { exploreConfig, seedProfiles } from './helpers.js';

const KEY = process.env.TYPESAFE_API_KEY;
const BENCH = fileURLToPath(
  new URL('../../../docs/benchmarks/jev.jsonl', import.meta.url),
);

/**
 * Appends one line per contract task to `docs/benchmarks/jev.jsonl`, so a change in System 1 (a new
 * `jev-latest`, a prompt edit) shows up as a change in pass rate, steps, latency or BLOCKED rate.
 */
function bench(
  task: string,
  cfg: LoadedConfig,
  x: Exploration,
  stop: ExploreStop,
  started: number,
): void {
  const log = join(runsPath(cfg), stop.runId, 'decisions.jsonl');
  const decisions: { ms: number; ranked: { op: string }[] }[] = existsSync(log)
    ? readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const ms = decisions.map((d) => d.ms).sort((a, b) => a - b);
  mkdirSync(dirname(BENCH), { recursive: true });
  appendFileSync(
    BENCH,
    `${JSON.stringify({
      at: dayjs().toISOString(),
      task,
      model: x.recording()?.model ?? 'unknown',
      status: stop.status,
      steps: stop.steps,
      wallMs: Date.now() - started,
      decisions: decisions.length,
      medianDecisionMs: ms[Math.floor(ms.length / 2)] ?? null,
      blockedTop: decisions.filter((d) => d.ranked[0]?.op === 'BLOCKED').length,
    })}\n`,
  );
}

/**
 * Real TypeSafe Jev against the fixture app (local env, fixture data only, ADR 0005).
 *
 * @remarks Opt-in and billed: `set -a; . spike/.env; set +a; bun run test:contract` (key from `spike/.env`). Not part of `verify`.
 */
describe.skipIf(KEY === undefined || KEY === '')(
  'TypeSafe Jev contract',
  () => {
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

    const config = async () => {
      const cfg = exploreConfig(fixture.url, 'https://api.typesafe.ai', {
        assertTimeout: 5000,
      });
      await seedProfiles(cfg, fixture.url);
      return cfg;
    };

    it('submits the leave form and saves a replayable flow', async () => {
      const cfg = await config();
      const started = Date.now();
      const x = await Exploration.start(
        cfg,
        {
          goal: 'Điền lý do nghỉ rồi bấm Gửi để gửi đơn',
          start: '/requests',
          profile: 'employee',
          inputs: { reason: { value: 'Việc riêng {{uid}}' } },
          assertions: [
            { network: { method: 'POST', url: '/api/requests', status: 201 } },
            { text: 'Đã gửi đơn' },
          ],
        },
        { browser },
      );
      const stop = await x.advance();
      bench('fixture: submit leave form', cfg, x, stop, started);
      expect(stop.status, JSON.stringify(stop)).toBe('passed');
      const saved = await saveExploration(cfg, x, {
        name: 'jev-submit',
        browser,
      });
      expect(saved.saved, JSON.stringify(saved.replay)).toBe(true);
    });

    it('adds a todo in an Enter-only form', async () => {
      const cfg = await config();
      const started = Date.now();
      const x = await Exploration.start(
        cfg,
        {
          goal: 'Thêm việc cần làm "Mua sữa" vào danh sách',
          start: '/lab',
          profile: 'employee',
          inputs: { todo: { value: 'Mua sữa' } },
          assertions: [{ text: 'Mua sữa' }],
        },
        { browser },
      );
      const stop = await x.advance();
      bench('fixture: todo via Enter', cfg, x, stop, started);
      expect(stop.status, JSON.stringify(stop)).toBe('passed');
    });
  },
);
