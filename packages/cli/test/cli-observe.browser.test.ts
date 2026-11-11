import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixture, type Fixture } from '@flowctl/fixture-app';
import { loadConfig } from '@flowctl/core';
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

/** `flowctl observe` (T2.7): a guarded, read-only crawl that prints a short summary and writes the map. */
let fixture: Fixture;
let configFile: string;
let out: string[];
let err: string[];

beforeAll(async () => {
  fixture = await startFixture();
  configFile = await fixtureProject(fixture.url, {
    target: { scope: { deny: ['/admin/**'] } },
  });
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

describe('flowctl observe', () => {
  it('crawls from --start, prints one line per page and writes appmap.json into the run directory', async () => {
    expect(
      await cli(['observe', '--start', '/map', '--config', configFile]),
    ).toBe(0);
    const text = out.join('');
    expect(text).toMatch(
      /^Observed 5 page\(s\) on http:\/\/127\.0\.0\.1:\d+ \(env local\), run r_/,
    );
    expect(text).toContain('  200 /requests  ');
    expect(text).toContain('    0 /map/hop  ');
    expect(text).toContain('refused: scope_violation');
    expect(text).toContain('Budget: 5/50 pages');
    const file = /^Map: (.+)$/m.exec(text)?.[1] ?? '';
    expect(file).toMatch(/appmap\.json$/);
    expect(JSON.parse(readFileSync(file, 'utf8')).pages).toHaveLength(5);
  });

  it('prints a compact JSON summary and copies the map to --out inside the flows root', async () => {
    const flows = loadConfig(configFile).flowsPath;
    const target = join(flows, 'maps', 'app.json');
    expect(
      await cli([
        'observe',
        '--start',
        '/map',
        '--json',
        '--out',
        target,
        '--config',
        configFile,
      ]),
    ).toBe(0);
    const s: Record<string, unknown> = JSON.parse(out.join(''));
    expect(s).toMatchObject({
      pages: 5,
      truncated: false,
      attention: ['/map/hop'],
    });
    expect(s).not.toHaveProperty('status');
    expect(s).not.toHaveProperty('error');
    expect(s.out).toBe(join(realpathSync(flows), 'maps', 'app.json'));
    expect(JSON.parse(readFileSync(target, 'utf8')).pages).toHaveLength(5);
  });

  it('refuses --out outside the flows root, under .auth, .git or .runs, over a non-map file, through a symlink or without .json (exit 2)', async () => {
    const flows = loadConfig(configFile).flowsPath;
    const elsewhere = join(tmpdir(), `flowctl-out-${Date.now()}`);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(flows, 'linked'));
    writeFileSync(join(flows, 'notes.json'), '{"keep": true}');
    for (const bad of [
      join(flows, '.runs', 'r_x', 'run.json'),
      join(flows, 'sub', '.git', 'map.json'),
      join(flows, 'notes.json'),
      join(elsewhere, 'map.json'),
      join(flows, '..', 'map.json'),
      join(flows, '.auth', 'local', 'employee.json'),
      join(flows, 'linked', 'map.json'),
      join(flows, 'map.yaml'),
    ]) {
      err.length = 0;
      expect(
        await cli([
          'observe',
          '--start',
          '/map',
          '--out',
          bad,
          '--config',
          configFile,
        ]),
        bad,
      ).toBe(2);
      expect(err.join(''), bad).toMatch(/--out|not inside|symlink/);
    }
    expect(readFileSync(join(flows, 'notes.json'), 'utf8')).toBe(
      '{"keep": true}',
    );
    expect(existsSync(join(elsewhere, 'map.json'))).toBe(false);
  });

  it('exits 2 when the crawl ends in an error, and is guarded like every command', async () => {
    expect(
      await cli([
        'observe',
        '--start',
        '/admin/settings',
        '--config',
        configFile,
      ]),
    ).toBe(2);
    expect(out.join('')).toContain('error: scope_violation');
    expect(out.join('')).not.toContain('Checks:');
    expect(await cli(['observe', 'extra', '--config', configFile])).toBe(2);
  });

  it('prints the free checks, writes checks.json beside the map, and exits 0 when they pass', async () => {
    expect(
      await cli(['observe', '--start', '/map', '--config', configFile]),
    ).toBe(0);
    const text = out.join('');
    expect(text).toContain('Checks: passed');
    const file = /^Checks file: (.+)$/m.exec(text)?.[1] ?? '';
    expect(file).toMatch(/checks\.json$/);
    expect(JSON.parse(readFileSync(file, 'utf8')).status).toBe('passed');
  });
});

describe('flowctl observe on an app with a crawl-class bug', () => {
  it('exits 1 when a free check fails, and names the check, the page and what was seen', async () => {
    const buggy = await startFixture('brokenLink');
    try {
      const file = await fixtureProject(buggy.url, {
        target: { scope: { deny: ['/admin/**'] } },
      });
      expect(await cli(['observe', '--start', '/map', '--config', file])).toBe(
        1,
      );
      const text = out.join('');
      expect(text).toMatch(/^Checks: failed \(.*no-broken-link.*\)$/m);
      expect(text).toContain('  no-4xx /map/missing: document 404');
      expect(text).toContain(
        '  no-broken-link /map: link to /map/missing (404)',
      );
      out.length = 0;
      expect(
        await cli(['observe', '--start', '/map', '--json', '--config', file]),
      ).toBe(1);
      const s: Record<string, unknown> = JSON.parse(out.join(''));
      expect(s.checks).toMatchObject({ status: 'failed' });
      expect(s).not.toHaveProperty('status');
    } finally {
      await buggy.close();
    }
  });
});
