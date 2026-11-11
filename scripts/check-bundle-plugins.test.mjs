/**
 * Tests for `check-bundle-plugins.mjs` (T0.16): each fixture is a throwaway repo with built output
 * (`packages/*\/dist` plus `src` stubs) that tries one way of loading a plugin or breaking core layering at
 * run time. The script runs for real in a child process. The script path can be overridden with
 * `BUNDLE_CHECK_SCRIPT` (mutation runs: a copy of the script set with one detection removed).
 * Helpers are in `check-bundle-plugins.helpers.mjs`; process, node_modules and discovery cases are in
 * `check-bundle-plugins.more.test.mjs`.
 */
import assert from 'node:assert/strict';
import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { A, CASE_INSENSITIVE, PLUGIN, SCRIPT, fails, inA, passes, pkg, run, tmp } from './check-bundle-plugins.helpers.mjs';

describe('check-bundle-plugins: clean tree', () => {
  it('passes when no plugin loads and layers point downwards', () => {
    const r = run();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ok \(cli, core\)/);
  });
  it('a higher layer loading a lower one is fine, and an entry may load anything', () => passes());
  it('ignores a plugin that nothing loads', () => passes(() => ({ 'plugin-example/dist/p.mjs': "throw new Error('never');\n" })));
});

describe('check-bundle-plugins: plugin loads the static scan can miss', () => {
  it('plain import of a plugin (baseline)', () => fails(inA((c) => `import '${c.P}';\n`), PLUGIN));
  it('names the importer and the importee', () =>
    fails(inA((c) => `import '${c.P}';\n`), /core: packages\/core\/dist\/flow\/a\.js -> packages\/plugin-example\/dist\/p\.mjs/));
  it('a non-core package loading a plugin (cli)', () =>
    fails((c) => ({ 'cli/dist/index.js': `import '${c.P}';\nexport {};\n` }), /cli: .* loads a plugin/));
  it('named import of _load from node:module', () =>
    fails(inA((c) => `import { _load } from 'node:module';\n_load('${c.PC}', null, false);\n`), PLUGIN));
  it('process.getBuiltinModule("module")', () =>
    fails(inA((c) => `process.getBuiltinModule('module')._load('${c.PC}', null, false);\nexport {};\n`), PLUGIN));
  it('module.constructor._load in a CommonJS file', () =>
    fails(
      (c) => ({
        'core/dist/index.js': "import './flow/a.cjs';\nexport {};\n",
        'core/dist/flow/a.cjs': `module.constructor._load('${c.PC}', null, false);\n`,
      }),
      PLUGIN,
      { remove: [A] },
    ));
  it('createRequire with a computed path', () =>
    fails(inA((c) => `import { createRequire } from 'node:module';\ncreateRequire(import.meta.url)(['${c.PC}'].join(''));\n`), PLUGIN));
  it('a data: specifier that imports a plugin', () =>
    fails(inA((c) => `await import('data:text/javascript,import "${c.P}"');\nexport {};\n`), PLUGIN));
  it('a data: module is attributed to the file that imported it', () =>
    fails(inA((c) => `await import('data:text/javascript,import "${c.P}"');\nexport {};\n`), /flow\/a\.js -> packages\/plugin/));
  const worker = (opt) => (c) =>
    `import { Worker } from 'node:worker_threads';\nawait new Promise((r) => new Worker(${JSON.stringify(`import ${JSON.stringify(c.P)}`)}, { eval: true${opt} }).on('exit', r));\n`;
  it('new Worker(code, { eval: true }) importing a plugin', () => fails(inA(worker('')), PLUGIN));
  it('the same Worker with env: {} (explicit env drops NODE_OPTIONS)', () => fails(inA(worker(', env: {}')), PLUGIN));
  for (const fn of ['execFileSync', 'execFile']) {
    it(`${fn} of a script path`, () =>
      fails(
        inA(
          (c) =>
            `import { ${fn} } from 'node:child_process';\n${fn}(${JSON.stringify(c.node)}, [${JSON.stringify(c.PR)}]${fn === 'execFile' ? ', () => {}' : ''});\nexport {};\n`,
        ),
        PLUGIN,
      ));
  }
  for (const fn of ['execSync', 'exec']) {
    it(`${fn} of a script path`, () =>
      fails(
        inA(
          (c) =>
            `import { ${fn} } from 'node:child_process';\n${fn}(${JSON.stringify(`"${c.node}" "${c.PR}"`)}${fn === 'exec' ? ', () => {}' : ''});\nexport {};\n`,
        ),
        PLUGIN,
      ));
  }
  it('node:vm code that reaches the default loader', () =>
    fails(
      inA(
        (c) =>
          `import vm from 'node:vm';\nawait vm.runInThisContext('import(${JSON.stringify(c.P)})', { importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER });\nexport {};\n`,
      ),
      PLUGIN,
    ));
  it('node:vm code handed a require function', () =>
    fails(
      inA(
        (c) =>
          `import vm from 'node:vm';\nimport { createRequire } from 'node:module';\nvm.runInNewContext('r(p)', { r: createRequire(import.meta.url), p: ${JSON.stringify(c.PC)} });\nexport {};\n`,
      ),
      PLUGIN,
    ));
  it('a module hook that rewrites a specifier to a plugin (seen by the load record)', () =>
    fails(
      inA(
        (c) =>
          `import { registerHooks } from 'node:module';\nregisterHooks({ resolve: (s, ctx, next) => (s === './x.js' ? { url: '${c.P}', shortCircuit: true } : next(s, ctx)) });\nawait import('./x.js');\nexport {};\n`,
      ),
      PLUGIN,
    ));
  it('a named import of register is reported as hook registration', () =>
    fails(inA(() => "import { register } from 'node:module';\nregister('data:text/javascript,export {}');\nexport {};\n"), /registered module hooks via register/));
  it('a named import of registerHooks is reported as hook registration', () =>
    fails(inA(() => "import { registerHooks } from 'node:module';\nregisterHooks({});\nexport {};\n"), /registered module hooks via registerHooks/));
  it('process.getBuiltinModule("module").registerHooks is reported', () =>
    fails(inA(() => "process.getBuiltinModule('module').registerHooks({});\nexport {};\n"), /registered module hooks via registerHooks/));
});

describe('check-bundle-plugins: plugin files that are not under packages/plugin-*', () => {
  it('a plugin copied to a temp folder and imported', () => fails(inA((c) => `import '${c.OUT}';\n`), /outside packages\/\*\/dist and the root node_modules/));
  it('a plugin copied into core/dist (no source file)', () =>
    fails(
      () => ({ [A]: "export const a = 1;\nimport './copied.js';\n", 'core/dist/flow/copied.js': 'export const p = 1;\n' }),
      /dist file with no source/,
      { orphans: ['core/dist/flow/copied.js'] },
    ));
  it('a plugin under node_modules/@acme/flowctl-plugin-*', () =>
    fails(
      (c) => ({
        'core/dist/flow/a.js': `export const a = 1;\nimport '${pathToFileURL(join(c.dir, 'node_modules/@acme/flowctl-plugin-foo/index.js')).href}';\n`,
        '../node_modules/@acme/flowctl-plugin-foo/index.js': 'export const p = 1;\n',
      }),
      PLUGIN,
    ));
});

describe('check-bundle-plugins: trace channel', () => {
  const tamper = (c) =>
    `import fs from 'node:fs';\nawait import('${c.P}');\nfor (const v of Object.values(process.env)) {\n  if (!v.startsWith('/') || !v.includes('/bundle-load-')) continue;\n  try { fs.writeFileSync(v, '{"t":"load","url":"${pathToFileURL(join(c.dir, 'packages/core/dist/index.js')).href}"}\\n'); } catch {}\n}\nexport {};\n`;
  it('code that overwrites every temp path in its environment cannot hide a plugin load', () => fails(inA(tamper), PLUGIN));
  it('a forged or garbage line on the trace channel fails the run', () =>
    fails(inA(() => "import fs from 'node:fs';\ntry { fs.writeSync(3, 'garbage\\n'); } catch {}\nexport {};\n"), /malformed trace line/));
  it('a forged event of the wrong shape fails the run', () =>
    fails(inA(() => "import fs from 'node:fs';\nfs.writeSync(3, '{\"t\":\"load\",\"url\":5}\\n');\nexport {};\n"), /unexpected trace event/));
  it('an empty trace fails (hook replaced by a no-op in a copy of the script set)', () => {
    const d = tmp('bundle-noop-');
    for (const f of ['check-bundle-plugins.mjs', 'bundle-load-analyse.mjs', 'bundle-load-driver.mjs', 'core-layers.mjs']) copyFileSync(join(dirname(SCRIPT), f), join(d, f));
    writeFileSync(join(d, 'bundle-load-hook.cjs'), "const k = Symbol.for('flowctl.bundle-load-hook');\nif (globalThis[k] === undefined) Object.defineProperty(globalThis, k, { value: { done() {} } });\n");
    fails(() => ({}), /recorded nothing/, { script: join(d, 'check-bundle-plugins.mjs') });
  });
});

describe('check-bundle-plugins: entries that do not settle', () => {
  it('an entry that exits the process before the imports settle (no done marker)', () =>
    fails(inA(() => 'process.exit(0);\n'), /did not report done/));
  it('a top-level await that never settles', () => fails(inA(() => 'await new Promise(() => {});\n'), /failed to load|did not report done/));
  it('a never-settling entry kept alive by a timer times out', () =>
    fails(inA(() => 'setInterval(() => {}, 1000);\nawait new Promise(() => {});\n'), /did not finish within/, { env: { BUNDLE_CHECK_TIMEOUT_MS: '3000' } }));
  it('an entry that throws while loading', () => fails(inA(() => "throw new Error('boom');\n"), /failed to load/));
  it('a missing build', () => fails(() => ({}), /run `bun run build` first/, { remove: ['core/dist'] }));
});

describe('check-bundle-plugins: entry resolution is Node\'s', () => {
  const entry = (exp, more) => () => ({ 'core/package.json': JSON.stringify({ name: '@x/core', type: 'module', exports: exp, ...more }) });
  it('import condition before default', () => passes(entry({ '.': { import: './dist/index.js', default: './dist/nope.js' } })));
  it('node condition before default', () => passes(entry({ '.': { node: './dist/index.js', default: './dist/nope.js' } })));
  it('top-level condition form', () => passes(entry({ node: './dist/index.js', default: './dist/nope.js' })));
  it('array target', () => passes(entry({ '.': ['./dist/index.js'] })));
  it('main without exports', () => passes(entry(undefined, { main: 'dist/index.js' })));
  it('main without exports still sees a plugin import', () =>
    fails((c) => ({ ...entry(undefined, { main: 'dist/index.js' })(), [A]: `export const a = 1;\nimport '${c.P}';\n` }), PLUGIN));
  it('a main that leaves the package', () => fails(entry(undefined, { main: '../cli/dist/index.js' }), /outside the package/));
});

describe('check-bundle-plugins: package discovery', () => {
  it('an unlisted package with a TypeScript entry is a failure', () =>
    fails(() => ({ 'extra/package.json': pkg('@x/extra', './src/index.ts'), 'extra/src/index.ts': 'export {};\n' }), /TypeScript source, not built/));
  it('the allowlisted source-only package (fixture-app) is skipped', () =>
    passes(() => ({ 'fixture-app/package.json': pkg('@x/fixture-app', './src/index.ts'), 'fixture-app/src/index.ts': 'export {};\n' })));
  it('a missing core fails', () => fails(() => ({}), /required package core/, { remove: ['core'] }));
  it('a missing cli fails', () => fails(() => ({}), /required package cli/, { remove: ['cli'] }));
  it('a package directory that is a symlink fails', () => fails(() => ({}), /not a plain directory/, { links: { linked: 'core' } }));
  it('a package without package.json fails', () => fails(() => ({ 'extra/dist/x.js': 'export {};\n' }), /no package\.json/));
  it('a root given through a symlink is canonicalised', () => fails(inA((c) => `import '${c.P}';\n`), PLUGIN, { viaLink: true }));
});

describe('check-bundle-plugins: every entry point, not only "."', () => {
  const sub = (body) => (c) => ({
    'core/package.json': pkg('@x/core', './dist/index.js', { exports: { '.': './dist/index.js', './extra': './dist/extra.js' } }),
    'core/dist/extra.js': body(c),
  });
  it('an exports subpath that loads cleanly passes', () => passes(sub(() => 'export {};\n')));
  it('an exports subpath that imports a plugin fails', () => fails(sub((c) => `import '${c.P}';\nexport {};\n`), PLUGIN));
  const bin = (body) => (c) => ({
    'cli/package.json': pkg('@x/cli', './dist/index.js', { bin: { x: './dist/bin.js' } }),
    'cli/dist/bin.js': body(c),
  });
  it('a bin that loads cleanly passes', () => passes(bin(() => 'export {};\n')));
  it('a bin that exits with status 2 fails (a rejected main maps to 2)', () => fails(bin(() => 'process.exitCode = 2;\n'), /bin dist\/bin\.js: exit 2, expected 0/));
  it('a bin that calls process.exit(2) fails', () => fails(bin(() => 'process.exit(2);\n'), /exit 2, expected 0/));
  it('a bin whose main rejects (the bin.ts shape) fails', () =>
    fails(bin(() => "Promise.reject(new Error('x')).then(() => {}, () => { process.exitCode = 2; });\n"), /exit 2, expected 0/));
  it('a bin that throws fails', () => fails(bin(() => "throw new Error('bin boom');\n"), /bin dist\/bin\.js: exit 1, expected 0/));
  it('a bin that exits 1 fails', () => fails(bin(() => 'process.exit(1);\n'), /exit 1, expected 0/));
  it('a bin that kills itself fails, named by signal', () =>
    fails(bin(() => "process.kill(process.pid, 'SIGKILL');\n"), /child killed by signal SIGKILL, expected 0/));
  it('many runs at once never close each other file descriptors (the double close that raised EBADF and SIGPIPE)', () => {
    const many = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`extra${i}/package.json`, pkg(`@x/extra${i}`, './dist/index.js')]));
    const dists = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`extra${i}/dist/index.js`, 'export {};\n']));
    for (let n = 0; n < 3; n++) passes(() => ({ ...many, ...dists }));
  });
  it('a bin is run with --help (it exits 0 only then)', () => passes(bin(() => 'process.exitCode = process.argv[2] === "--help" ? 0 : 1;\n')));
  it('a bin is run with a scrubbed environment', () =>
    passes(bin(() => 'process.exitCode = process.env.BUNDLE_SECRET === undefined ? 0 : 1;\n'), { env: { BUNDLE_SECRET: 'x' } }));
  it('a bin that imports a plugin fails', () => fails(bin((c) => `import '${c.P}';\n`), PLUGIN));
  it('a bin listed in package.json but not built fails', () => fails(bin(() => ''), /missing or outside the package/, { remove: ['cli/dist/bin.js'] }));
});

describe('check-bundle-plugins: layering', () => {
  it('a lower layer loading a higher one', () =>
    fails(inA(() => "import '../run/b.js';\nexport {};\n"), /core\/flow loads the higher layer core\/run/));
  it('a layer loading the entry file', () => fails(inA(() => "import '../index.js';\nexport {};\n"), /loads the entry file/));
  it('a layer loading a top-level entry (replay)', () =>
    fails(() => ({ 'core/dist/replay.js': 'export {};\n', [A]: "import '../replay.js';\nexport {};\n" }), /loads the entry file/));
  it('a lower layer reaching a higher one through a data: module', () =>
    fails(inA((c) => `await import('data:text/javascript,import "${c.B}"');\nexport {};\n`), /core\/flow loads the higher layer core\/run/));
  it('a folder missing from CORE_LAYERS (importee)', () =>
    fails(() => ({ 'core/dist/weird/x.js': 'export {};\n', 'core/dist/run/b.js': "import '../weird/x.js';\nexport {};\n" }), /"weird" is not in CORE_LAYERS/));
  it('a module of a folder missing from CORE_LAYERS loading anything (importer)', () =>
    fails(
      () => ({
        'core/dist/index.js': "import './weird/x.js';\nexport {};\n",
        'core/dist/weird/x.js': "import '../flow/a.js';\nexport {};\n",
      }),
      /core "weird" is not in CORE_LAYERS/,
    ));
});

describe('check-bundle-plugins: case-insensitive file systems', () => {
  const skip = !CASE_INSENSITIVE && 'this file system is case-sensitive';
  it('a plugin imported through a case-variant path', { skip }, () =>
    fails(inA((c) => `import '${c.P.replace('/packages/plugin-example/', '/Packages/Plugin-Example/')}';\n`), PLUGIN));
  it('a higher layer imported through a case-variant path', { skip }, () =>
    fails(inA((c) => `import '${c.B.replace('/packages/core/dist/', '/PACKAGES/CORE/DIST/')}';\nexport {};\n`), /higher layer/));
});
