import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { stringify } from 'yaml';
import {
  parseConfig,
  storageStatePath,
  type LoadedConfig,
} from '../src/config.js';
import { loadFlow, type Flow } from '../src/flow/index.js';
import {
  DRAFT_PROVENANCE,
  RunSession,
  type RunSessionOptions,
} from '../src/run/index.js';
import { FIXTURE_FLOWS_DIR } from '@flowctl/fixture-app';

export const PROFILES = ['employee', 'manager'];

/** Config rooted in a fresh temp dir; flows live in <root>/.flows. */
export function fixtureConfig(
  baseUrl: string,
  extra: Record<string, unknown> = {},
): LoadedConfig {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-'));
  return parseConfig(
    {
      defaultEnv: 'local',
      envs: { local: { baseUrl, loginUrl: '/login' } },
      profiles: { employee: {}, manager: {} },
      assertTimeout: 3000,
      stepTimeout: 3000,
      ...extra,
    },
    root,
  );
}

/** Saves a storageState per profile by hitting the fixture's /login?as=<profile>. */
export async function seedProfiles(
  cfg: LoadedConfig,
  baseUrl: string,
): Promise<void> {
  const browser = await chromium.launch();
  for (const profile of PROFILES) {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    await page.goto(`/login?as=${profile}`);
    const path = storageStatePath(cfg, 'local', profile);
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
    await context.close();
  }
  await browser.close();
}

export function copyFlows(cfg: LoadedConfig): void {
  cpSync(FIXTURE_FLOWS_DIR, cfg.flowsPath, { recursive: true });
}

export function writeFlow(
  cfg: LoadedConfig,
  doc: Record<string, unknown> & { name: string },
): Flow {
  mkdirSync(cfg.flowsPath, { recursive: true });
  const file = join(cfg.flowsPath, `${doc.name}.yaml`);
  writeFileSync(file, stringify(doc));
  return loadFlow(file, PROFILES);
}

/** A page signed in as `profile` on the fixture, opened at `path`. */
export async function openAs(
  browser: Browser,
  baseUrl: string,
  path: string,
  profile = 'employee',
): Promise<Page> {
  const page = await browser.newPage({ baseURL: baseUrl });
  await page.goto(`/login?as=${profile}`);
  await page.goto(path);
  return page;
}

/** Environment handed to `createDriver` in tests (the fake accepts any key). */
export const VARS = { TYPESAFE_API_KEY: 'test-key' };

/** Fixture config that explores with the fake System 1 at `system1Url`. */
export function exploreConfig(
  baseUrl: string,
  system1Url: string,
  extra: Record<string, unknown> = {},
): LoadedConfig {
  return fixtureConfig(baseUrl, {
    system1: { baseUrl: system1Url, allowedEnvs: ['local'] },
    ...extra,
  });
}

/** `RunSession.open` for a test: the run's provenance is the fixed draft label unless the test sets its own. */
export const openRun = (
  cfg: LoadedConfig,
  flow: Flow,
  opts: Omit<RunSessionOptions, 'provenance'> &
    Partial<Pick<RunSessionOptions, 'provenance'>>,
): RunSession =>
  RunSession.open(cfg, flow, { provenance: DRAFT_PROVENANCE, ...opts });
