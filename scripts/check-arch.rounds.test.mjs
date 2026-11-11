/**
 * Architecture gate tests (rounds): see check-arch.helpers.mjs for how the gate is run.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BOUNDARY, GATE, PLUGIN, dirs, env, fails, passes, run } from './check-arch.helpers.mjs';

describe('check-arch bypass round: root wiring', () => {
  const ROOT_TSCONFIG = (extra) => `{"compilerOptions":${extra},"references":[{"path":"packages/plugin-example"}]}\n`;
  it('fails a root tsconfig paths entry that maps into a plugin', () =>
    fails({ 'tsconfig.json': ROOT_TSCONFIG('{"paths":{"@flowctl/core":["packages/plugin-example/src"]}}') }, BOUNDARY));
  it('fails an escaped root tsconfig paths entry', () =>
    fails({ 'tsconfig.json': ROOT_TSCONFIG('{"paths":{"x":["packages/plugin\\u002dexample/src"]}}') }, BOUNDARY));
  it('still allows the root tsconfig references', () =>
    passes({ 'tsconfig.json': ROOT_TSCONFIG('{"strict":true}') }));
  for (const [file, text] of [
    ['playwright.config.ts', `import x from '${PLUGIN}';\n`],
    ['build.mjs', "await import('./packages/plugin-example/src/index.js');\n"],
    ['.githooks/pre-push', 'bun run --cwd packages/plugin-example test\n'],
    ['.github/dependabot.yml', 'updates:\n  - directory: "/packages/plugin-example"\n'],
  ])
    it(`fails in ${file}`, () => fails({ [file]: text }, BOUNDARY));
});

describe('check-arch round 2: denial of service and fail-closed parsing', () => {
  it('scans a large leading comment in front of deeply nested nodes in bounded time', () => {
    const text = `/*${'x'.repeat(20_000_000)}*/\na${'+a'.repeat(1500)};\n`;
    const t0 = Date.now();
    const r = run({ 'packages/cli/bin/a.mjs': text });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  });
  it('fails an unterminated comment and a truncated import in core', () => {
    fails({ 'packages/core/src/flow/a.ts': "/* unterminated import '../index.js';\n" }, /syntax error/);
    fails({ 'packages/core/src/flow/a.ts': 'import {\n' }, /syntax error/);
  });
  it('compares the package scope case-insensitively', () =>
    fails({ 'packages/core/src/flow/a.ts': "import '@FlowCtl/CLI';\n" }, /core may not depend on cli/));
  it('strips ?query and #hash before the entry-file test', () => {
    fails({ 'packages/core/lib/x.ts': "import '../src/index.js?x';\n" }, /may not import the entry file/);
    fails({ 'packages/core/lib/x.ts': "import '../src/index.js#y';\n" }, /may not import the entry file/);
    fails({ 'packages/core/src/browser/a.ts': "import '../run/index.js?x';\n" }, /may not import core\/run/);
  });
});

describe('check-arch round 2: plugin names from package.json and wiring', () => {
  it('reads a plugin package.json that starts with a BOM', () =>
    fails(
      {
        'packages/plugin-zed/package.json': '\uFEFF{"name":"zed-adapter"}\n',
        'packages/cli/src/zz.ts': "export * from 'zed-adapter';\n",
      },
      BOUNDARY,
    ));
  it('fails when a plugin package.json cannot be parsed', () =>
    fails({ 'packages/plugin-zed/package.json': '{"name":' }, /plugin package\.json cannot be read or parsed/));
  it('decodes percent-encoding until it stops changing', () =>
    fails({ 'packages/cli/bin/x.mjs': "await import('../../plugin%2525252Dexample/src/index.js');\n" }, BOUNDARY));
  it('decodes TOML eight-digit escapes', () =>
    fails({ 'packages/cli/a.toml': 'x = "\\U00000070lugin-example"\n' }, BOUNDARY));
  it('joins backslash line continuations', () => {
    fails({ 'packages/cli/a.yml': 'x: "plugin\\\n   -example"\n' }, BOUNDARY);
    fails({ 'packages/cli/a.toml': 'x = "plugin\\\n   -example"\n' }, BOUNDARY);
  });
  for (const file of [
    'build.sh',
    'Justfile',
    'Containerfile',
    '.npmrc',
    '.env',
    '.gitmodules',
    '.github/renovate.json',
    '.github/scripts/x.sh',
    '.claude/hooks/x.mjs',
    '.claude/settings.json',
    '.husky/pre-commit',
  ])
    it(`fails in ${file}`, () =>
      fails({ [file]: file.endsWith('.mjs') ? "await import('./packages/plugin-example/x.js');\n" : 'bun run --cwd packages/plugin-example test\n' }, BOUNDARY));
  it('does not exempt a file that only has the name of a missing gate script', () =>
    fails({ 'scripts/check-not-a-gate.mjs': `import "${PLUGIN}";\n` }, BOUNDARY));
  it('exempts the T0.16 bundle check and its test, which must name a plugin to detect it', () =>
    passes({ 'scripts/check-bundle-plugins.mjs': `import "${PLUGIN}";\n`, 'scripts/check-bundle-plugins.test.mjs': `import "${PLUGIN}";\n` }));
  it('still ignores prose docs', () =>
    passes({ 'docs/a.md': `See ${PLUGIN}\n`, 'README.md': `See ${PLUGIN}\n` }));
});

describe('check-arch round 2: dynamic loading is not checkable', () => {
  const RUN = 'packages/core/src/browser/a.ts';
  const INDIRECT = /indirect module loader cannot be checked/;
  const BASE = "import { createRequire } from 'node:module';\nconst r = createRequire(import.meta.url);\n";
  const CASES = {
    'r.call': "export const m = r.call(null, '../run/index.js');\n",
    'r.apply': "export const m = r.apply(null, ['../run/index.js']);\n",
    'array element': "export const m = [r][0]('../run/index.js');\n",
    'object property': "const o = { r };\nexport const m = o.r('../run/index.js');\n",
    ternary: "export const m = (globalThis.c ? r : r)('../run/index.js');\n",
    'arrow returning it': "const g = () => r;\nexport const m = g()('../run/index.js');\n",
    'destructured resolve': "const { resolve: q } = createRequire(import.meta.url);\nexport const m = q('../run/index.js');\n",
    'passed as argument': "export const m = [1].map(r);\n",
  };
  for (const [name, text] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [RUN]: BASE + text }, INDIRECT));
  it('fails a computed key on the module namespace', () =>
    fails(
      { [RUN]: "import * as M from 'node:module';\nconst k = 'createRequire';\nexport const m = M[k](import.meta.url);\n" },
      INDIRECT,
    ));
  it('fails process.mainModule', () =>
    fails({ [RUN]: "export const m = process.mainModule?.require('../run/index.js');\n" }, INDIRECT));
  it('fails eval and new Function', () => {
    fails({ [RUN]: "export const m = eval('1');\n" }, /eval\/Function/);
    fails({ [RUN]: "export const m = new Function('return 1');\n" }, /eval\/Function/);
  });
  it('still allows direct, aliased and resolve uses', () =>
    passes({
      [RUN]: `${BASE}export const a = r.resolve('./x.js');\nexport const b = r('./y.js');\nexport type T = typeof require;\n`,
    }));
  it('applies the non-literal rule to cli and fixture-app, not to their tests', () => {
    fails({ 'packages/cli/src/a.ts': 'export const m = (p) => import(p);\n' }, /non-literal specifier cannot be checked/);
    fails({ 'packages/fixture-app/src/a.ts': 'export const m = (p) => require(p);\n' }, /non-literal specifier cannot be checked/);
    passes({ 'packages/cli/test/a.test.ts': 'export const m = (p) => import(p);\n' });
  });
  it('fails import.meta.glob and a readdir of the packages directory', () => {
    fails({ 'packages/cli/src/a.ts': "export const m = import.meta.glob('../../*/src/*.ts');\n" }, /enumerating the packages/);
    fails(
      { 'packages/core/src/flow/a.ts': "import { readdirSync } from 'node:fs';\nexport const m = readdirSync(join(root, 'packages'));\n" },
      /enumerating the packages/,
    );
    passes({ 'packages/cli/src/a.ts': "import { readdirSync } from 'node:fs';\nexport const m = readdirSync('flows');\n" });
  });
});

describe('check-arch round 2: specifiers in comments and ambient modules', () => {
  const RUN = 'packages/core/src/browser/a.ts';
  const ENTRY = /may not import the entry file/;
  const CASES = {
    'jsdoc @import': "/** @import {X} from '../index.js' */\nexport const a = 1;\n",
    'jsdoc import type': "/** @type {import('../index.js').X} */\nexport const a = 1;\n",
    'declare module': "declare module '../index.js' {}\nexport const a = 1;\n",
    'reference path': '/// <reference path="../index.js" />\nexport const a = 1;\n',
  };
  for (const [name, text] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [RUN]: text }, ENTRY));
  it('leaves a legal comment specifier alone', () =>
    passes({ [RUN]: "/** @import {X} from '../flow/index.js' */\nexport const a = 1;\n" }));
});

describe('check-arch round 3', () => {
  const RUN = 'packages/core/src/foundation/a.ts';
  it('fails a backslash inside a relative specifier', () => {
    fails({ [RUN]: "import { run } from './x\\..\\..\\run/index.js';\n" }, /contains a backslash/);
    fails({ [RUN]: "import { c } from './x\\..\\..\\..\\..\\cli/src/index.js';\n" }, /contains a backslash/);
    fails({ [RUN]: "import { run } from './x\\\\..\\\\..\\\\run/index.js';\n" }, /contains a backslash/);
    fails({ 'packages/cli/src/a.ts': "import { c } from './x\\..\\y.js';\n" }, /contains a backslash/);
    fails({ [RUN]: "import { c } from './x%5C..%5Cy.js';\n" }, /contains a backslash/);
  });
  it('fails an exported createRequire result or require alias', () => {
    const base = "import { createRequire } from 'node:module';\n";
    for (const decl of ['export const', 'export let', 'export var'])
      fails({ [RUN]: `${base}${decl} load = createRequire(import.meta.url);\n` }, /indirect module loader/);
    fails({ [RUN]: 'export const load = require;\n' }, /indirect module loader/);
    fails({ [RUN]: "export const load = module.require;\n" }, /indirect module loader/);
  });
  it('decodes valid percent escapes even when another one is malformed', () =>
    fails({ 'scripts/x.mjs': "await import('../packages/plugin%2Dexample/dist/index.js?%zz');\n" }, BOUNDARY));
  it('keeps decoding in the layer check when a later escape is malformed', () =>
    fails({ 'packages/core/src/browser/a.ts': "import '../run%2Findex.js?%zz';\n" }, /may not import core\/run/));
  it('scans .mdx and code files under docs/, still skips prose', () => {
    fails({ 'docs/gen.mjs': "await import('../packages/plugin-example/x.js');\n" }, BOUNDARY);
    fails({ 'docs/a.mdx': `import x from '${PLUGIN}'\n` }, BOUNDARY);
    fails({ 'docs/a.yml': 'run: packages/plugin-example\n' }, BOUNDARY);
    fails({ 'a.mdx': `import x from '${PLUGIN}'\n` }, BOUNDARY);
    passes({ 'docs/a.md': `${PLUGIN}\n`, 'docs/a.txt': `${PLUGIN}\n`, 'docs/a.rst': `${PLUGIN}\n` });
  });
  it('scans a hostile comment of quote and backslash pairs in linear time', () => {
    const t0 = Date.now();
    const r = run({ 'packages/cli/bin/a.mjs': `/*${'"a\\'.repeat(80_000)}*/\nexport const a = 1;\n` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
  });
  it('still sees a quoted plugin name after an apostrophe in prose', () =>
    fails({ 'packages/cli/bin/a.mjs': `/* don't "${PLUGIN}" */\nexport const a = 1;\n` }, BOUNDARY));
  it('does not read a plugin package.json that is a symlink', () =>
    fails({ 'packages/plugin-zed/real.json': '{"name":"x"}\n' }, /plugin package\.json is a symbolic link or not a regular file/, {
      'packages/plugin-zed/package.json': 'real.json',
    }));
  it('names the file when the scan crashes on deep nesting', () =>
    fails({ 'packages/cli/bin/a.mjs': `${'['.repeat(60_000)}${']'.repeat(60_000)};\n` }, /a\.mjs {2}cannot be scanned/));
  it('fails a gitlink that is not checked out', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-arch-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    writeFileSync(join(dir, 'ok.txt'), 'x\n');
    execFileSync('git', ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},packages/core/vendored`], { cwd: dir, env });
    const out = spawnSync('node', [GATE], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stderr, /packages\/core\/vendored {2}gitlink/);
  });
  it('exempts only the exact gate file names from the generator tripwire', () => {
    fails({ 'scripts/check-arch-evil.mjs': 'export const f = saveAsGenerator;\n' }, /saveAsGenerator is internal/);
    fails({ 'scripts/module-specs.evil.mjs': 'export const f = saveAsGenerator;\n' }, /saveAsGenerator is internal/);
    fails({ 'scripts/check-arch.test.mjs': 'export const f = saveAsGenerator;\n' }, /saveAsGenerator is internal/);
    passes({ 'scripts/check-arch.helpers.mjs': 'export const f = saveAsGenerator;\n' });
  });
  it('does not exempt the deleted single test file name from the plugin scan', () => {
    fails({ 'scripts/check-arch.test.mjs': `import x from '${PLUGIN}';\nexport default x;\n` }, BOUNDARY);
  });
});
