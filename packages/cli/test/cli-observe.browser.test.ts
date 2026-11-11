import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
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
    const s: {
      status: string;
      pages: number;
      attention: string[];
      out: string;
    } = JSON.parse(out.join(''));
    expect(s).toMatchObject({
      status: 'passed',
      pages: 5,
      attention: ['/map/hop'],
    });
    expect(s.out).toBe(join(realpathSync(flows), 'maps', 'app.json'));
    expect(JSON.parse(readFileSync(target, 'utf8')).pages).toHaveLength(5);
  });

  it('refuses --out outside the flows root, under .auth, through a symlink or without .json (exit 2)', async () => {
    const flows = loadConfig(configFile).flowsPath;
    const elsewhere = join(tmpdir(), `flowctl-out-${Date.now()}`);
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(flows, 'linked'));
    for (const bad of [
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
    expect(await cli(['observe', 'extra', '--config', configFile])).toBe(2);
  });
});
