#!/usr/bin/env node
/**
 * Builds the release tarballs of ADR 0031 from the built workspace (`bun run build` first) and proves they
 * install: each released package is staged with its `dist/`, docs and licence files and the manifest of
 * `release-manifest.mjs`, packed with `npm pack`, then installed together into an empty project from the local
 * files and run with `--help`.
 *
 * @example node scripts/pack-release.mjs --version 0.2.0 --out release
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RELEASED, releaseManifest, tarballName } from './release-manifest.mjs';

const ROOT = resolve(import.meta.dirname, '..');
/** Files copied next to `dist/` when the package has them. */
const EXTRA = ['README.md', 'THIRD_PARTY_NOTICES.md', 'skill'];
const ROOT_FILES = ['LICENSE', 'NOTICE'];

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const version = arg('version');
const out = resolve(arg('out') ?? 'release');
if (!version) throw new Error('usage: pack-release.mjs --version <x.y.z> [--out <dir>]');
if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
mkdirSync(out, { recursive: true });

const stageRoot = mkdtempSync(join(tmpdir(), 'flowctl-pack-'));
const packed = {};
try {
  for (const dir of RELEASED) {
    const src = join(ROOT, 'packages', dir);
    const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
    if (!existsSync(join(src, 'dist', 'index.js'))) throw new Error(`${dir}: no dist/index.js; run bun run build`);
    const stage = join(stageRoot, dir);
    cpSync(join(src, 'dist'), join(stage, 'dist'), { recursive: true });
    const files = ['dist'];
    for (const f of EXTRA)
      if (existsSync(join(src, f))) {
        cpSync(join(src, f), join(stage, f), { recursive: true });
        files.push(f);
      }
    for (const f of ROOT_FILES) {
      cpSync(join(ROOT, f), join(stage, f));
      files.push(f);
    }
    const manifest = { ...releaseManifest(pkg, version), files };
    writeFileSync(join(stage, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    execFileSync('npm', ['pack', '--silent', '--pack-destination', out], { cwd: stage, stdio: ['ignore', 'ignore', 'inherit'] });
    const file = join(out, tarballName(pkg.name, version));
    if (!existsSync(file)) throw new Error(`npm pack did not write ${file}`);
    packed[pkg.name] = file;
  }
  smoke(packed);
} finally {
  rmSync(stageRoot, { recursive: true, force: true });
}
process.stdout.write(`pack-release: ${Object.values(packed).join(', ')}\n`);

/** Installs the tarballs into an empty project (local files stand in for the release URLs) and runs both bins. */
function smoke(files) {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-smoke-'));
  try {
    const local = Object.fromEntries(Object.entries(files).map(([n, f]) => [n, `file:${f}`]));
    const project = { name: 'smoke', private: true, type: 'module', dependencies: local, overrides: local };
    writeFileSync(join(dir, 'package.json'), JSON.stringify(project));
    execFileSync('npm', ['install', '--silent', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'inherit' });
    for (const bin of ['flowctl', 'flowctl-mcp'])
      execFileSync(join(dir, 'node_modules', '.bin', bin), ['--help'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
    execFileSync('node', ['-e', "import('@flowctl/core').then((m) => { if (typeof m.replayFlow !== 'function') process.exit(1); })"], { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
