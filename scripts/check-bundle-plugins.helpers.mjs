/**
 * Shared helpers for the `check-bundle-plugins*.test.mjs` files: builds a throwaway repo with built
 * output, runs `check-bundle-plugins.mjs` on it and asserts on the outcome. Not a test file (the harness
 * glob is `scripts/*.test.mjs`). The script path can be overridden with `BUNDLE_CHECK_SCRIPT` (mutation
 * runs: a copy of the script set with one detection removed).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const SCRIPT = process.env.BUNDLE_CHECK_SCRIPT ?? join(HERE, 'check-bundle-plugins.mjs');
const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
export const tmp = (prefix) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(d);
  return d;
};
export const pkg = (name, exp, more = {}) => JSON.stringify({ name, type: 'module', exports: { '.': exp }, ...more });
export const CASE_INSENSITIVE = (() => {
  const d = tmp('case-probe-');
  writeFileSync(join(d, 'x'), '');
  return existsSync(join(d, 'X'));
})();

/**
 * Writes a repo (clean files, then `extra(ctx)` on top) and returns its root. File keys are relative to
 * `packages/` (`../node_modules/x` reaches the root).
 * `opts`: `remove` (paths to delete), `orphans` (dist files that get no src stub), `links` (path under
 * packages/ to relative target), `rootLinks` (path under the root to a target relative to the root),
 * `viaLink` (return the root through a symlink).
 */
export const make = (extra = () => ({}), opts = {}) => {
  const dir = tmp('bundle-check-');
  const at = (p) => join(dir, 'packages', p);
  const out = tmp('bundle-outside-');
  writeFileSync(join(out, 'p.mjs'), 'export const p = 1;\n');
  const ctx = {
    dir,
    P: pathToFileURL(at('plugin-example/dist/p.mjs')).href,
    PC: at('plugin-example/dist/p.cjs'),
    PR: at('plugin-example/dist/run.mjs'),
    B: pathToFileURL(at('core/dist/run/b.js')).href,
    OUT: pathToFileURL(join(out, 'p.mjs')).href,
    node: process.execPath,
    at,
  };
  const files = {
    'core/package.json': pkg('@x/core', './dist/index.js'),
    'core/dist/index.js': "import './flow/a.js';\nimport './run/b.js';\nexport {};\n",
    'core/dist/flow/a.js': 'export const a = 1;\n',
    'core/dist/run/b.js': "import { a } from '../flow/a.js';\nexport const b = a;\n",
    'cli/package.json': pkg('@x/cli', { default: './dist/index.js' }),
    'cli/dist/index.js': 'export {};\n',
    'plugin-example/package.json': pkg('@x/flowctl-plugin-example', './dist/p.mjs'),
    'plugin-example/dist/p.mjs': 'export const p = 1;\n',
    'plugin-example/dist/p.cjs': 'module.exports = 1;\n',
    'plugin-example/dist/run.mjs': 'export const r = 1;\n',
    ...extra(ctx),
  };
  for (const path of Object.keys(files)) {
    const stub = /^(core|cli|extra\d*)\/dist\/(.+)\.[cm]?js$/.exec(path);
    if (stub !== null && !(opts.orphans ?? []).includes(path)) files[`${stub[1]}/src/${stub[2]}.ts`] = 'export {};\n';
  }
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), text);
  }
  for (const path of opts.remove ?? []) rmSync(at(path), { recursive: true, force: true });
  for (const [path, target] of Object.entries(opts.links ?? {})) symlinkSync(target, at(path));
  for (const [path, target] of Object.entries(opts.rootLinks ?? {})) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    symlinkSync(join(dir, target), join(dir, path));
  }
  let root = dir;
  if (opts.viaLink) {
    root = join(tmp('bundle-link-'), 'repo');
    symlinkSync(dir, root);
  }
  return root;
};
/** `opts.env` is added to the environment; `opts.script` replaces the script under test. */
export const run = (extra = () => ({}), opts = {}) =>
  spawnSync(process.execPath, [opts.script ?? SCRIPT, '--root', make(extra, opts)], {
    encoding: 'utf8',
    timeout: 120_000,
    env: { ...process.env, ...opts.env },
  });
export const fails = (extra, pattern, opts) => {
  const r = run(extra, opts);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, pattern);
};
export const passes = (extra, opts) => {
  const r = run(extra, opts);
  assert.equal(r.status, 0, r.stdout + r.stderr);
};
/**
 * Copies the script set to a temp dir with text replacements (`{ file: [[from, to]] }`) and returns the
 * path of the copied `check-bundle-plugins.mjs`; used to test constants such as `PATTERN_ALLOWED`.
 */
export const withScript = (edits = {}) => {
  const d = tmp('bundle-scripts-');
  for (const f of ['check-bundle-plugins.mjs', 'bundle-load-analyse.mjs', 'bundle-load-driver.mjs', 'bundle-load-hook.cjs', 'core-layers.mjs']) {
    let text = readFileSync(join(dirname(SCRIPT), f), 'utf8');
    for (const [from, to] of edits[f] ?? []) {
      assert.ok(text.includes(from), `${f} has no ${from}`);
      text = text.replace(from, to);
    }
    writeFileSync(join(d, f), text);
  }
  return join(d, 'check-bundle-plugins.mjs');
};
export const A = 'core/dist/flow/a.js';
export const PLUGIN = /loads a plugin/;
export const inA = (body) => (ctx) => ({ [A]: `export const a = 1;\n${body(ctx)}` });
