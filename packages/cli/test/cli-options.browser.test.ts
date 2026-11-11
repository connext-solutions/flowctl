import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { loadConfig, storageStatePath } from '@flowctl/core';
import { chromium, type Page } from 'playwright';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cli, fixtureProject } from './helpers.js';

const FAILING_FLOW = `name: always-fails
goal: A flow whose assertion can never hold
tags: [broken]
profile: employee
start: /requests
steps:
  - click: { role: button, name: "Gửi" }
assertions:
  - text: "this text is never on the page"
`;

let fixture: Fixture;
let configFile: string;
let out: string[];
let err: string[];

beforeAll(async () => {
  fixture = await startFixture();
  configFile = await fixtureProject(fixture.url, {
    envs: {
      local: { baseUrl: fixture.url, loginUrl: '/login' },
      other: { baseUrl: fixture.url, loginUrl: '/login' },
    },
  });
  writeFileSync(
    join(dirname(configFile), '.flows', 'always-fails.yaml'),
    FAILING_FLOW,
  );
});
afterAll(async () => {
  await fixture.close();
});
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => {
    err.push(String(s));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Records the `headless` option of each launch but always runs headless, so the test needs no display.
 */
function recordLaunches(): { headless: (boolean | undefined)[] } {
  const seen: { headless: (boolean | undefined)[] } = { headless: [] };
  const real = chromium.launch.bind(chromium);
  vi.spyOn(chromium, 'launch').mockImplementation((options) => {
    seen.headless.push(options?.headless);
    return real({ ...options, headless: true });
  });
  return seen;
}

describe('flowctl replay options', () => {
  it('exits 1 and names the failed assertion when a flow fails', async () => {
    expect(await cli(['replay', 'always-fails', '--config', configFile])).toBe(
      1,
    );
    const text = out.join('');
    expect(text).toContain('✘ always-fails [local] assertion');
    expect(text).toContain('0 passed, 1 failed, 0 flaky, 0 errors');
  });

  it('exits 1 when one flow fails among passing ones', async () => {
    expect(await cli(['replay', '--json', '--config', configFile])).toBe(1);
    const s: { passed: number; failed: number; results: unknown[] } =
      JSON.parse(out.join(''));
    expect(s.failed).toBe(1);
    expect(s.passed).toBe(s.results.length - 1);
    expect(s.passed).toBeGreaterThan(0);
  });

  it('--env selects the env: it is reported in the result and an unknown one exits 2', async () => {
    expect(
      await cli([
        'replay',
        'leave-validation',
        '--env',
        'local',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    expect(out.join('')).toContain('✔ leave-validation [local]');
    out.length = 0;
    expect(
      await cli([
        'replay',
        'leave-validation',
        '--env',
        'other',
        '--config',
        configFile,
      ]),
    ).toBe(2);
    expect(out.join('')).toContain('leave-validation [other]');
    expect(await cli(['replay', '--env', 'nope', '--config', configFile])).toBe(
      2,
    );
    expect(err.join('')).toContain('nope');
  });

  it('--repeat runs each flow that many times', async () => {
    expect(
      await cli([
        'replay',
        'leave-validation',
        '--repeat',
        '3',
        '--json',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    const s: { results: unknown[]; flows: { runs: number }[] } = JSON.parse(
      out.join(''),
    );
    expect(s.results).toHaveLength(3);
    expect(s.flows.map((f) => f.runs)).toEqual([3]);
  });

  it('--repeat rejects a non-integer', async () => {
    expect(
      await cli(['replay', '--repeat', 'abc', '--config', configFile]),
    ).toBe(2);
    expect(err.join('')).toContain('--repeat must be a positive integer');
  });

  it('--headed launches a visible browser, and the default is headless', async () => {
    const seen = recordLaunches();
    expect(
      await cli(['replay', 'leave-validation', '--config', configFile]),
    ).toBe(0);
    expect(seen.headless).toEqual([true]);
    expect(
      await cli([
        'replay',
        'leave-validation',
        '--headed',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    expect(seen.headless).toEqual([true, false]);
  });
});

describe('flowctl login', () => {
  /**
   * Closes the login window once the CLI is waiting for it, as a person would after logging in.
   */
  function closeWindowWhenPrompted(): void {
    const real = chromium.launch.bind(chromium);
    vi.spyOn(chromium, 'launch').mockImplementation(async (options) => {
      const browser = await real({ ...options, headless: true });
      const newContext = browser.newContext.bind(browser);
      vi.spyOn(browser, 'newContext').mockImplementation(async (o) => {
        const context = await newContext(o);
        context.on('page', (page: Page) => {
          void vi
            .waitFor(
              () => {
                if (!err.join('').includes('close the window'))
                  throw new Error('waiting');
              },
              { timeout: 10_000, interval: 50 },
            )
            .then(() => page.close());
        });
        return context;
      });
      return browser;
    });
  }

  it('saves the session once the window is closed and reports the path', async () => {
    const file = await fixtureProject(fixture.url, {
      envs: { local: { baseUrl: fixture.url, loginUrl: '/login?as=manager' } },
    });
    const state = storageStatePath(loadConfig(file), 'local', 'manager');
    rmSync(state);
    closeWindowWhenPrompted();
    expect(await cli(['login', 'manager', '--config', file])).toBe(0);
    expect(existsSync(state)).toBe(true);
    expect(err.join('')).toContain(`Saved session to ${state}`);
  });

  it('exits 2 and saves nothing when the window closes on the login page', async () => {
    const file = await fixtureProject(fixture.url);
    const state = storageStatePath(loadConfig(file), 'local', 'manager');
    rmSync(state);
    closeWindowWhenPrompted();
    expect(await cli(['login', 'manager', '--config', file])).toBe(2);
    expect(err.join('')).toContain('still on the login page');
    expect(existsSync(state)).toBe(false);
  });

  it('exits 2 for an unknown profile and prints usage without a profile', async () => {
    expect(await cli(['login', 'ghost', '--config', configFile])).toBe(2);
    expect(err.join('')).toContain('Unknown profile "ghost"');
    err.length = 0;
    expect(await cli(['login', '--config', configFile])).toBe(2);
    expect(err.join('')).toContain('Usage:');
  });

  it('exits 2 for an unknown --env', async () => {
    expect(
      await cli(['login', 'manager', '--env', 'nope', '--config', configFile]),
    ).toBe(2);
    expect(err.join('')).toContain('nope');
  });
});

describe('flowctl cleanup', () => {
  it('cleanup refuses a run id that is not one (exit 2) and a run without a ledger (exit 3) (T1.3)', async () => {
    for (const bad of ['../x', 'R_1', `r_${'a'.repeat(33)}`]) {
      err.length = 0;
      expect(await cli(['cleanup', bad, '--config', configFile])).toBe(2);
      expect(err.join('')).toContain('is not a run id');
    }
    err.length = 0;
    expect(
      await cli(['cleanup', 'r_lq3k2a1b9f0e', '--config', configFile]),
    ).toBe(3);
    expect(err.join('')).toContain('no ledger for run r_lq3k2a1b9f0e');
  });
});
