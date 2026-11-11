import { startFixture, type Fixture } from '@flowctl/fixture-app';
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
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { join } from 'node:path';
import { loadConfig } from '@flowctl/core';
import { cli, fixtureProject } from './helpers.js';

const OLD_FLOW = `name: old-flow
goal: An old flow with a malformed template
profile: employee
start: /requests/{{uid+1}}
steps:
  - reload: true
assertions:
  - text: "ok"
`;

const FAILING_FLOW = `name: always-fails
goal: A valid flow whose assertion cannot hold
tags: [broken]
profile: employee
start: /requests
steps:
  - reload: true
assertions:
  - text: "this text is never on the page"
`;

let fixture: Fixture;
let configFile: string;
let out: string[];
let err: string[];

beforeAll(async () => {
  fixture = await startFixture();
  configFile = await fixtureProject(fixture.url);
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

describe('flowctl cli', () => {
  it('replays every flow and exits 0', async () => {
    expect(await cli(['replay', '--config', configFile])).toBe(0);
    expect(out.join('')).toContain('4 passed, 0 failed, 0 flaky, 0 errors');
  });

  it('runs the valid flows and reports an invalid file as flow_invalid (exit 2)', async () => {
    const file = await fixtureProject(fixture.url);
    const flowsPath = loadConfig(file).flowsPath;
    writeFileSync(join(flowsPath, 'old-flow.yaml'), OLD_FLOW);
    expect(await cli(['replay', '--json', '--config', file])).toBe(2);
    const s: {
      results: {
        flow: string;
        status: string;
        error?: { kind: string; hint: string };
      }[];
      passed: number;
      errors: number;
    } = JSON.parse(out.join(''));
    expect(s.passed).toBe(4);
    expect(s.errors).toBe(1);
    const bad = s.results.find((r) => r.flow === 'old-flow');
    expect(bad?.status).toBe('error');
    expect(bad?.error?.kind).toBe('flow_invalid');
    expect(bad?.error?.hint).toContain('old-flow.yaml');
    expect(bad?.error?.hint).toContain('{{uid+1}}');
  });

  it('still reports the invalid file when a tag filter selects other flows', async () => {
    const file = await fixtureProject(fixture.url);
    writeFileSync(join(loadConfig(file).flowsPath, 'old-flow.yaml'), OLD_FLOW);
    expect(await cli(['replay', '--tag', 'negative', '--config', file])).toBe(
      2,
    );
    expect(out.join('')).toContain('! old-flow');
    expect(out.join('')).toContain('1 passed, 0 failed, 0 flaky, 1 errors');
  });

  it('does not multiply an invalid file under --repeat', async () => {
    const file = await fixtureProject(fixture.url);
    writeFileSync(join(loadConfig(file).flowsPath, 'old-flow.yaml'), OLD_FLOW);
    expect(
      await cli([
        'replay',
        'leave-validation',
        '--repeat',
        '2',
        '--json',
        '--config',
        file,
      ]),
    ).toBe(2);
    const s: { results: { flow: string }[] } = JSON.parse(out.join(''));
    expect(s.results.filter((r) => r.flow === 'old-flow')).toHaveLength(1);
    expect(s.results.filter((r) => r.flow === 'leave-validation')).toHaveLength(
      2,
    );
  });

  it('reports an invalid file that a name filter excludes', async () => {
    const file = await fixtureProject(fixture.url);
    writeFileSync(join(loadConfig(file).flowsPath, 'old-flow.yaml'), OLD_FLOW);
    expect(await cli(['replay', 'leave-validation', '--config', file])).toBe(2);
    expect(out.join('')).toContain('! old-flow');
    expect(out.join('')).toContain('1 passed, 0 failed, 0 flaky, 1 errors');
  });

  it('exits 2, not 1, when an invalid file sits next to a failing flow', async () => {
    const file = await fixtureProject(fixture.url);
    const flowsPath = loadConfig(file).flowsPath;
    writeFileSync(join(flowsPath, 'old-flow.yaml'), OLD_FLOW);
    writeFileSync(join(flowsPath, 'always-fails.yaml'), FAILING_FLOW);
    expect(await cli(['replay', 'always-fails', '--config', file])).toBe(2);
    expect(out.join('')).toContain('0 passed, 1 failed, 0 flaky, 1 errors');
  });

  it('names the file in the hint for YAML syntax and unreadable files', async () => {
    const file = await fixtureProject(fixture.url);
    const flowsPath = loadConfig(file).flowsPath;
    writeFileSync(join(flowsPath, 'broken.yaml'), 'name: [unclosed');
    mkdirSync(join(flowsPath, 'x.yaml'));
    expect(
      await cli(['replay', 'leave-validation', '--json', '--config', file]),
    ).toBe(2);
    const s: { results: { flow: string; error?: { hint: string } }[] } =
      JSON.parse(out.join(''));
    expect(s.results.find((r) => r.flow === 'broken')?.error?.hint).toContain(
      'broken.yaml',
    );
    expect(s.results.find((r) => r.flow === 'x')?.error?.hint).toContain(
      'x.yaml',
    );
  });

  it('launches no browser when every flow file is invalid', async () => {
    const file = await fixtureProject(fixture.url);
    const flowsPath = loadConfig(file).flowsPath;
    for (const f of [
      'leave-approve.yaml',
      'leave-persist.yaml',
      'leave-submit.yaml',
      'leave-validation.yaml',
    ])
      rmSync(join(flowsPath, f));
    writeFileSync(join(flowsPath, 'old-flow.yaml'), OLD_FLOW);
    const launch = vi.spyOn(chromium, 'launch');
    try {
      expect(await cli(['replay', '--config', file])).toBe(2);
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
    expect(out.join('')).toContain('0 passed, 0 failed, 0 flaky, 1 errors');
  });

  it('filters by tag and prints JSON', async () => {
    expect(
      await cli([
        'replay',
        '--tag',
        'negative',
        '--json',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    const s: { results: { flow: string }[] } = JSON.parse(out.join(''));
    expect(s.results.map((r) => r.flow)).toEqual(['leave-validation']);
  });

  it('exits 2 for an unknown flow, a bad --repeat and a missing command', async () => {
    expect(await cli(['replay', 'nope', '--config', configFile])).toBe(2);
    expect(err.join('')).toContain('Flow not found: nope');
    expect(await cli(['replay', '--repeat', '0', '--config', configFile])).toBe(
      2,
    );
    expect(await cli([])).toBe(2);
    expect(err.join('')).toContain('Usage:');
  });

  it('exits 2 when no config can be found', async () => {
    expect(
      await cli(['replay', '--config', '/nonexistent/flowctl.config.yaml']),
    ).toBe(2);
    expect(err.join('')).toContain('No flowctl.config.yaml found');
  });

  it('refuses --heal on an env where System 1 is not allowed', async () => {
    const file = await fixtureProject(fixture.url, {
      system1: { baseUrl: 'http://127.0.0.1:9', allowedEnvs: ['staging'] },
    });
    const code = await cli(['replay', '--heal', '--config', file]);
    expect(code).toBe(2);
    expect(err.join('')).toContain('not allowed');
  });
});

describe('flowctl trust (ADR 0021, ADR 0025)', () => {
  it('refuses to change the trust store without a terminal', async () => {
    expect(await cli(['trust', 'init', '--config', configFile])).toBe(3);
    expect(err.join('')).toContain('tty_required');
  });

  it.each([
    [['default-env', 'nope'], 'is not classed'],
    [['language', 'Vietnamese'], 'not a language code'],
    [['locale', 'vi_VN'], 'not a locale'],
    [['production-origin', 'https://erp.example.com/x'], 'not an origin'],
    [['production-origin', 'https://erp.example.com'], 'tty_required'],
  ])(
    'trust add %j exits 3 with %s before any prompt (T1.0)',
    async (args, says) => {
      expect(await cli(['trust', 'add', ...args, '--config', configFile])).toBe(
        3,
      );
      expect(err.join('')).toContain(says);
    },
  );

  it.each([
    [['employee', 'QA_PASSWORD', 'secret'], 'tty_required'],
    [['nobody', 'QA_PASSWORD', 'secret'], 'no profile "nobody"'],
    [['employee', 'QA_PASSWORD', 'token'], 'secret or username'],
  ])(
    'trust add profile %j exits 3 with %s and changes nothing (T1.14)',
    async (args, says) => {
      expect(
        await cli(['trust', 'add', 'profile', ...args, '--config', configFile]),
      ).toBe(3);
      expect(err.join('')).toContain(says);
    },
  );

  it('refuses the removed `trust <name>` form and names the new command', async () => {
    expect(await cli(['trust', 'leave-approve', '--config', configFile])).toBe(
      2,
    );
    expect(err.join('')).toContain('flowctl trust hook leave-approve');
  });

  it('ignores --trust-hooks with a warning; sample flows have no hooks and still replay', async () => {
    expect(
      await cli([
        'replay',
        'leave-approve',
        '--trust-hooks',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    expect(err.join('')).toContain('--trust-hooks is ignored');
  });
});
