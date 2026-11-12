import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from '@flowctl/core';
import {
  FIXTURE_CONTRACTS_DIR,
  startFixture,
  type Fixture,
} from '@flowctl/fixture-app';
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
import { cli, fixtureProject } from './helpers.js';

/** `flowctl reconcile` (T6.6) on runs of the fixture app: a failed replay classed, and gaps from a real crawl. */
let fixture: Fixture;
let configFile: string;
let root: string;
let out: string[];
let err: string[];

const STALE_FLOW = `name: submit-stale
goal: the saved message is shown
profile: employee
start: /requests
steps:
  - reload: true
assertions:
  - text: "Đã gửi đơn thành công"
`;

const SPEC = `---
id: submit-stale
title: Gửi đơn
actor: employee
---

# Gửi đơn

### Kết quả mong đợi

- Màn hình hiện thông báo "Đã gửi đơn thành công".
`;

const ROUTES = `import { Route, Routes } from 'react-router-dom';
export const App = () => (
  <Routes>
    <Route path="/map" />
    <Route path="/never-crawled" />
  </Routes>
);
`;

beforeAll(async () => {
  fixture = await startFixture();
  configFile = await fixtureProject(fixture.url, {
    target: { scope: { deny: ['/admin/**'] } },
  });
  root = dirname(configFile);
  writeFileSync(
    join(loadConfig(configFile).flowsPath, 'submit-stale.yaml'),
    STALE_FLOW,
  );
  cpSync(FIXTURE_CONTRACTS_DIR, join(root, 'web'), { recursive: true });
  mkdirSync(join(root, 'specs'));
  writeFileSync(join(root, 'specs', 'submit-stale.md'), SPEC);
  mkdirSync(join(root, 'app', 'src'), { recursive: true });
  writeFileSync(join(root, 'app', 'src', 'routes.tsx'), ROUTES);
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

/** Replays the stale flow (it fails) and returns its run id. */
async function failedRun(): Promise<string> {
  expect(
    await cli(['replay', 'submit-stale', '--json', '--config', configFile]),
  ).toBe(1);
  const s: { results: { runId: string; status: string }[] } = JSON.parse(
    out.join(''),
  );
  out.length = 0;
  expect(s.results[0]?.status).toBe('failed');
  return s.results[0]?.runId ?? '';
}

describe('flowctl reconcile <run id>', () => {
  it('classes a failed replay with the code index and writes classification.json into its run directory', async () => {
    const id = await failedRun();
    expect(
      await cli([
        'reconcile',
        id,
        '--code',
        join(root, 'web'),
        '--config',
        configFile,
      ]),
    ).toBe(0);
    const text = out.join('');
    expect(text).toMatch(
      new RegExp(
        `^Run ${id} \\(flow submit-stale, failed\\): stale_test, confidence low$`,
        'm',
      ),
    );
    expect(text).toContain('label-stale (stale_test, low):');
    expect(text).toContain(
      'run.json /failed/assertion/text: Đã gửi đơn thành công',
    );
    expect(text).toContain('code i18n/vi.json:');
    const file = join(
      loadConfig(configFile).flowsPath,
      '.runs',
      id,
      'classification.json',
    );
    expect(JSON.parse(readFileSync(file, 'utf8')).class).toBe('stale_test');
  });

  it('reads the spec operation named like the flow, and prints the Classification with --json', async () => {
    const id = await failedRun();
    expect(
      await cli([
        'reconcile',
        id,
        '--code',
        join(root, 'web'),
        '--spec',
        join(root, 'specs'),
        '--json',
        '--config',
        configFile,
      ]),
    ).toBe(0);
    const c: {
      runId: string;
      class: string;
      confidence: string;
      basis: { rule: string; evidence: { source: string }[] }[];
    } = JSON.parse(out.join(''));
    expect(c).toMatchObject({ runId: id, class: 'spec_drift' });
    expect(c.basis[0]?.rule).toBe('label-spec-drift');
    expect(c.basis[0]?.evidence.map((e) => e.source)).toContain('code');
  });

  it('refuses a run id that is not one and a --code outside the project root (exit 2)', async () => {
    expect(await cli(['reconcile', '../../etc', '--config', configFile])).toBe(
      2,
    );
    expect(err.join('')).toContain('is not a run id');
    const id = await failedRun();
    const outside = mkdtempSync(join(tmpdir(), 'flowctl-outside-'));
    expect(
      await cli(['reconcile', id, '--code', outside, '--config', configFile]),
    ).toBe(2);
    expect(err.join('')).toContain('is not inside the project root');
  });
});

describe('flowctl reconcile --gaps', () => {
  it('reads the latest crawl, writes gaps.json and gaps.md under the flows directory and prints a count per kind', async () => {
    expect(
      await cli(['observe', '--start', '/map', '--config', configFile]),
    ).toBe(0);
    const map = /^Map: (.+)$/m.exec(out.join(''))?.[1] ?? '';
    out.length = 0;
    expect(
      await cli([
        'reconcile',
        '--gaps',
        '--code',
        join(root, 'app'),
        '--config',
        configFile,
      ]),
      err.join(''),
    ).toBe(0);
    const text = out.join('');
    const runId = basename(dirname(map));
    expect(text).toMatch(
      new RegExp(`^Coverage gaps from .+/${runId}/appmap\\.json `, 'm'),
    );
    expect(text).toContain('Checked: route_unvisited, page_no_route');
    expect(text).toContain('  route_unvisited: 1');
    expect(text).toContain(
      'Not checked (an input is missing): operation_no_ui, operation_ambiguous, page_no_spec',
    );
    const flows = loadConfig(configFile).flowsPath;
    const gaps: { gaps: { kind: string; route?: { path: string } }[] } =
      JSON.parse(readFileSync(join(flows, 'gaps', 'gaps.json'), 'utf8'));
    expect(
      gaps.gaps
        .filter((g) => g.kind === 'route_unvisited')
        .map((g) => g.route?.path),
    ).toEqual(['/never-crawled']);
    expect(existsSync(join(flows, 'gaps', 'gaps.md'))).toBe(true);

    out.length = 0;
    const target = join(flows, 'reports');
    expect(
      await cli([
        'reconcile',
        '--gaps',
        '--appmap',
        map,
        '--spec',
        join(root, 'specs'),
        '--out',
        target,
        '--config',
        configFile,
      ]),
    ).toBe(0);
    expect(out.join('')).toContain(
      'Checked: operation_no_ui, operation_ambiguous, page_no_spec',
    );
    expect(existsSync(join(target, 'gaps.json'))).toBe(true);
    expect(
      await cli([
        'reconcile',
        '--gaps',
        '--out',
        join(flows, '.runs'),
        '--config',
        configFile,
      ]),
    ).toBe(2);
  });
});
