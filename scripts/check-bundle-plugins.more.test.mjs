/**
 * Tests for `check-bundle-plugins.mjs` (T0.16), part 2: orphans and process hygiene, node_modules,
 * discovery shapes. See `check-bundle-plugins.helpers.mjs` for how fixtures are built.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { A, PLUGIN, SCRIPT, fails, inA, make, passes, pkg, run, tmp, withScript } from './check-bundle-plugins.helpers.mjs';

describe('check-bundle-plugins: orphans and process hygiene', () => {
  const spawnIn = (c, code, opts = "{ detached: true, stdio: 'ignore' }") =>
    `import { spawn } from 'node:child_process';\nspawn(${JSON.stringify(c.node)}, ['-e', ${JSON.stringify(code)}], ${opts}).unref();\nexport {};\n`;
  for (const ms of [100, 300, 1000]) {
    it(`an orphan that imports a plugin ${ms} ms after the entry exits`, () =>
      fails(inA((c) => spawnIn(c, `setTimeout(() => import(${JSON.stringify(c.P)}), ${ms})`)), PLUGIN));
  }
  const timed = { env: { BUNDLE_CHECK_TIMEOUT_MS: '1500' } };
  it('a detached descendant alive at the timeout fails the run, promptly', () => {
    const t0 = Date.now();
    fails(inA((c) => spawnIn(c, 'setTimeout(() => {}, 8000)')), /did not finish within/, timed);
    assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
  });
  it('a descendant that holds the stdio pipes is killed with the process group, promptly', () => {
    const t0 = Date.now();
    fails(inA((c) => spawnIn(c, 'setTimeout(() => {}, 20000)', "{ stdio: 'inherit' }")), /did not finish within/, timed);
    assert.ok(Date.now() - t0 < 12_000, `took ${Date.now() - t0} ms`);
  });
  it('an untraced descendant (env: {}) alive at the end fails the run and is killed with the group', async () => {
    const marker = join(tmp('bundle-marker-'), 'alive');
    const code = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 3500)`;
    fails(inA((c) => spawnIn(c, code, "{ stdio: 'inherit', env: {} }")), /did not finish within/, timed);
    await new Promise((r) => setTimeout(r, 4500));
    assert.equal(existsSync(marker), false, 'the descendant survived the run');
  });
  for (const v of ['abc', '0', '-5', '1e3', '999999999', '']) {
    it(`BUNDLE_CHECK_TIMEOUT_MS=${JSON.stringify(v)} is one clear line`, () => {
      const r = run(() => ({}), { env: { BUNDLE_CHECK_TIMEOUT_MS: v } });
      assert.equal(r.status, 1);
      assert.match(r.stderr, /^check-bundle-plugins: BUNDLE_CHECK_TIMEOUT_MS must be an integer from 1 to 600000\n$/);
    });
  }
  it('a missing mkfifo is one clear line, not a stack trace', () => {
    const r = run(() => ({}), { env: { PATH: '/nonexistent' } });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /^check-bundle-plugins: cannot create the trace FIFO[^\n]*\n$/);
  });
  it('a trace flood fails closed', () =>
    fails(inA(() => "import fs from 'node:fs';\nconst big = 'x'.repeat(1 << 20);\nfor (let i = 0; i < 40; i++) fs.writeSync(3, big);\nexport {};\n"), /\(flood\)/));
  it('SIGTERM kills the child group and removes the temp directory', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'bundle-sigterm-'));
    try {
      const root = make(inA(() => 'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n'));
      const child = spawn(process.execPath, [SCRIPT, '--root', root], { stdio: 'ignore', env: { ...process.env, TMPDIR: scratch } });
      await new Promise((r) => setTimeout(r, 1500));
      assert.ok(readdirSync(scratch).length > 0, 'the run should have created temp directories');
      child.kill('SIGTERM');
      const code = await new Promise((r) => child.on('exit', r));
      assert.equal(code, 143);
      assert.deepEqual(readdirSync(scratch), []);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe('check-bundle-plugins: node_modules', () => {
  const dep = (name) => ({ 'core/package.json': pkg('@x/core', './dist/index.js', { dependencies: { [name]: '1' } }) });
  const imp = (c, rel) => `export const a = 1;\nimport '${pathToFileURL(join(c.dir, rel)).href}';\n`;
  const P = 'export const p = 1;\n';
  const UNDECLARED = /declared by no workspace package\.json/;
  it('an undeclared package in the root node_modules fails', () =>
    fails((c) => ({ [A]: imp(c, 'node_modules/zzz/p.mjs'), '../node_modules/zzz/p.mjs': P }), UNDECLARED));
  it('a package under packages/core/node_modules fails even if declared', () =>
    fails(
      (c) => ({ ...dep('zzz'), [A]: imp(c, 'packages/core/node_modules/zzz/p.mjs'), 'core/node_modules/zzz/p.mjs': P }),
      /outside packages\/\*\/dist and the root node_modules/,
    ));
  it('plugin text under an innocent scoped name fails', () =>
    fails(
      (c) => ({ [A]: imp(c, 'node_modules/@acme/example-adapter/p.mjs'), '../node_modules/@acme/example-adapter/p.mjs': P }),
      UNDECLARED,
    ));
  it('a declared package in the root node_modules passes', () =>
    passes((c) => ({ ...dep('zzz'), [A]: imp(c, 'node_modules/zzz/p.mjs'), '../node_modules/zzz/p.mjs': P })));
  it('a package listed in the lockfile passes', () =>
    passes((c) => ({
      [A]: imp(c, 'node_modules/yyy/p.mjs'),
      '../node_modules/yyy/p.mjs': P,
      '../bun.lock': '{\n  "packages": {\n    "yyy": ["yyy@1.0.0", "", {}, "sha"],\n  }\n}\n',
    })));
  it('an unscoped flowctl-plugin-* package in node_modules fails even if declared', () =>
    fails((c) => ({ ...dep('flowctl-plugin-x'), [A]: imp(c, 'node_modules/flowctl-plugin-x/p.mjs'), '../node_modules/flowctl-plugin-x/p.mjs': P }), PLUGIN));
  it('a scoped declared package passes', () =>
    passes((c) => ({ ...dep('@s/pkg'), [A]: imp(c, 'node_modules/@s/pkg/p.mjs'), '../node_modules/@s/pkg/p.mjs': P })));
  it('an aliased dependency in the lockfile (first tuple element is the real name) passes under either name', () =>
    passes((c) => ({
      [A]: imp(c, 'node_modules/realname/p.mjs'),
      '../node_modules/realname/p.mjs': P,
      '../bun.lock': '{\n  "packages": {\n    "alias": ["realname@2.0.0", "", {}, "sha"],\n  }\n}\n',
    })));
  it('a nested node_modules package is judged by its own name', () =>
    fails(
      (c) => ({ ...dep('yyy'), [A]: imp(c, 'node_modules/yyy/node_modules/zzz/p.mjs'), '../node_modules/yyy/node_modules/zzz/p.mjs': P }),
      /package "zzz" is declared by no workspace/,
    ));
  it('a declared name that is a symlink into a plugin fails as a plugin', () =>
    fails((c) => ({ ...dep('zzz'), [A]: imp(c, 'node_modules/zzz/dist/p.mjs') }), PLUGIN, {
      rootLinks: { 'node_modules/zzz': 'packages/plugin-example' },
    }));
});

describe('check-bundle-plugins: discovery shapes', () => {
  const exp = (exports, more, extra = {}) => ({
    'core/package.json': JSON.stringify({ name: '@x/core', type: 'module', exports, ...more }),
    ...extra,
  });
  it('an exports pattern with * is a problem that names how to allow it', () =>
    fails(() => exp({ '.': './dist/index.js', './internal/*': './dist/internal/*.js' }), /exports pattern \.\/internal\/\* cannot be enumerated.*PATTERN_ALLOWED/));
  it('exports without a name is a problem', () =>
    fails(() => ({ 'core/package.json': JSON.stringify({ type: 'module', exports: { '.': './dist/index.js' } }) }), /has exports but no name/));
  it('./package.json and types-only subpaths are skipped without error', () =>
    passes(() => exp({ '.': './dist/index.js', './package.json': './package.json', './types': { types: './dist/types.d.ts' } })));
  it('a dotfile in packages/ is ignored', () => passes(() => ({ '.DS_Store': 'x' })));
  it('a dot directory without package.json is not', () => fails(() => ({ '.hidden/x.txt': 'x' }), /no package\.json/));
  it('the require condition gets a CommonJS pass', () =>
    fails(
      (c) => exp({ '.': { import: './dist/index.js', require: './dist/c.cjs' } }, {}, { 'core/dist/c.cjs': `require('${c.PC}');\n` }),
      PLUGIN,
    ));
  it('a clean require condition passes', () =>
    passes(() => exp({ '.': { import: './dist/index.js', require: './dist/c.cjs' } }, {}, { 'core/dist/c.cjs': 'module.exports = 1;\n' })));
  it('a custom condition gets its own pass, and a plugin behind it is found', () =>
    fails(
      (c) => exp({ '.': { custom: './dist/c.js', default: './dist/index.js' } }, {}, { 'core/dist/c.js': `import '${c.P}';\nexport {};\n` }),
      /core \[conditions custom\]: .*loads a plugin/,
    ));
  it('a combined condition path (custom then require) gets a pass with both', () =>
    fails(
      (c) => exp({ '.': { custom: { require: './dist/c.cjs' }, default: './dist/index.js' } }, {}, { 'core/dist/c.cjs': `require('${c.PC}');\n` }),
      /core \[conditions custom,require\]: .*loads a plugin/,
    ));
  it('a nested condition path (a then b) gets a pass with both', () =>
    fails(
      (c) => exp({ '.': { a: { b: './dist/ev.js' }, default: './dist/index.js' } }, {}, { 'core/dist/ev.js': `import '${c.P}';\nexport {};\n` }),
      /core \[conditions a,b\]: .*loads a plugin/,
    ));
  it('conditions in an array target are found', () =>
    fails(
      (c) => exp({ '.': { custom: ['./dist/c.js'], default: './dist/index.js' } }, {}, { 'core/dist/c.js': `import '${c.P}';\nexport {};\n` }),
      /\[conditions custom\]: .*loads a plugin/,
    ));
  it('a .d.mts target as a plain string is loaded, not skipped', () =>
    fails(
      (c) => exp({ '.': './dist/index.js', './x': './dist/x.d.mts' }, {}, { 'core/dist/x.d.mts': `import '${c.P}';\nexport {};\n` }),
      /TypeScript source, not built/,
    ));
  it('a .d.ts target under a non-types condition is loaded', () =>
    fails(
      (c) => exp({ '.': './dist/index.js', './x': { default: './dist/x.d.ts' } }, {}, { 'core/dist/x.d.ts': `import '${c.P}';\nexport {};\n` }),
      /TypeScript source, not built/,
    ));
  it('a types decoy next to a real target does not hide the real one', () =>
    fails(
      (c) => exp({ '.': './dist/index.js', './x': { types: './dist/x.d.ts', default: './dist/x.js' } }, {}, { 'core/dist/x.js': `import '${c.P}';\nexport {};\n` }),
      PLUGIN,
    ));
  it('a string-form bin is run', () =>
    fails((c) => ({ 'cli/package.json': JSON.stringify({ name: '@x/cli', type: 'module', exports: { '.': './dist/index.js' }, bin: './dist/bin.js' }), 'cli/dist/bin.js': `import '${c.P}';\n` }), PLUGIN));
  it('an allow-listed exports pattern is not loaded and not a problem', () => {
    const script = withScript({ 'check-bundle-plugins.mjs': [['const PATTERN_ALLOWED = new Set();', "const PATTERN_ALLOWED = new Set(['core./internal/*']);"]] });
    passes(() => exp({ '.': './dist/index.js', './internal/*': './dist/internal/*.js' }), { script });
  });
  it('same-layer imports are allowed', () =>
    passes(() => ({ [A]: "export const a = 1;\nimport './c.js';\n", 'core/dist/flow/c.js': 'export const c = 1;\n' })));
  it('a plugin directory with a case-variant name is not checked, but loading from it is', () =>
    fails(
      (c) => ({
        'Plugin-Other/package.json': pkg('@x/other', './p.mjs'),
        'Plugin-Other/p.mjs': 'export {};\n',
        [A]: `export const a = 1;\nimport '${pathToFileURL(c.at('Plugin-Other/p.mjs')).href}';\n`,
      }),
      PLUGIN,
    ));
  it('an unterminated trace line fails the run', () =>
    fails(inA(() => "import fs from 'node:fs';\nsetTimeout(() => fs.writeSync(3, '{\"t\":\"load\"'), 100);\nexport {};\n"), /unterminated trace line/));
  it('a Worker with execArgv: [] and env: {} is still traced (the hook patches Worker)', () =>
    fails(
      inA(
        (c) =>
          `import { Worker } from 'node:worker_threads';\nawait new Promise((r) => new Worker(${JSON.stringify(`import ${JSON.stringify(c.P)}`)}, { eval: true, execArgv: [], env: {} }).on('exit', r));\n`,
      ),
      PLUGIN,
    ));
});
