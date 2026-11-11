import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  loadConfig,
  parseConfig,
  storageStatePath,
  type TrustStore,
} from '@flowctl/core';
import { testStore } from '@flowctl/core-testing';
import { FIXTURE_FLOWS_DIR } from '@flowctl/fixture-app';
import { chromium } from 'playwright';
import { stringify } from 'yaml';
import { runCli } from '../src/main.js';

/**
 * A throwaway project for the fixture app: writes flowctl.config.yaml, copies the sample flows and
 * saves a session for both profiles.
 *
 * @returns The path of the written config file.
 */
export async function fixtureProject(
  baseUrl: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-cli-'));
  const raw = {
    defaultEnv: 'local',
    envs: { local: { baseUrl, loginUrl: '/login' } },
    profiles: { employee: {}, manager: {} },
    assertTimeout: 3000,
    stepTimeout: 3000,
    ...extra,
  };
  const file = join(root, 'flowctl.config.yaml');
  writeFileSync(file, stringify(raw));
  const cfg = parseConfig(raw, root);
  cpSync(FIXTURE_FLOWS_DIR, cfg.flowsPath, { recursive: true });
  const browser = await chromium.launch();
  for (const profile of ['employee', 'manager']) {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    await page.goto(`/login?as=${profile}`);
    const path = storageStatePath(cfg, 'local', profile);
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
    await context.close();
  }
  await browser.close();
  return file;
}

const stores = new Map<string, TrustStore>();

/**
 * Runs the CLI with a trust store registering the project of the `--config` file in `argv` (made once per
 * file), the way an owner who ran `flowctl trust init` would. Without `--config` there is no store.
 */
export function cli(argv: string[]): Promise<number> {
  const at = argv.indexOf('--config');
  const file = at < 0 ? undefined : argv[at + 1];
  return runCli(argv, {
    openStore: () => {
      if (file === undefined) return undefined;
      const known = stores.get(file);
      if (known !== undefined) return known;
      const made = testStore(loadConfig(file));
      stores.set(file, made);
      return made;
    },
  });
}
