/**
 * Architecture gate tests (calls): see check-arch.helpers.mjs for how the gate is run.
 */
import { describe, it } from 'node:test';
import { BOUNDARY, PLUGIN, fails, passes } from './check-arch.helpers.mjs';

describe('check-arch bypass round: comments, regex literals, name prefixes', () => {
  const FLOW = 'packages/core/src/flow/a.ts';
  const CASES = {
    'reference types': [FLOW, `/// <reference types="${PLUGIN}" />\nexport const a = 1;\n`],
    'reference path': [FLOW, '/// <reference path="../../plugin-example/src/index.ts" />\nexport const a = 1;\n'],
    'jsdoc @import': [FLOW, '/** @import { p } from "../../plugin-example/src/index.js" */\nexport const a = 1;\n'],
    'jsdoc import type in js': [
      'packages/cli/bin/a.js',
      '/** @type {import("../../plugin-example/src/index.js").P} */\nexport const a = 1;\n',
    ],
    'comment after code on the same line': [FLOW, `export const a = 1; /* import("${PLUGIN}") */\n`],
    'regex literal source': [
      'packages/cli/bin/a.js',
      "export const m = import('@acme/flowctl-' + /plugin-example/.source);\n",
    ],
    'template tail': [FLOW, 'export const m = (n) => import(`@acme/flowctl-plugin-${n}`);\n'],
    'name prefix before a variable': [FLOW, "export const m = (n) => import('../../plugin-' + n);\n"],
    'bare flowctl-plugin- prefix': [FLOW, "export const m = (n) => import('flowctl-plugin-' + n);\n"],
  };
  for (const [name, [file, text]] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [file]: text }, BOUNDARY));
  it('still passes a comment that names the plugin in prose', () =>
    passes({ [FLOW]: `/** See ${PLUGIN} for the adapter. */\nexport const a = 1;\n` }));
});

describe('check-arch bypass round: layer call forms', () => {
  const RUN = 'packages/core/src/browser/a.ts';
  const UP = /may not import core\/run/;
  const CASES = {
    'parenthesised import argument': "export const m = import(('../run/index.js'));\n",
    'as-expression import argument': "export const m = import('../run/index.js' as string);\n",
    'parenthesised callee': "const r = require;\nexport const m = (r)('../run/index.js');\n",
    'aliased createRequire':
      "import { createRequire as cr } from 'node:module';\nexport const m = cr(import.meta.url)('../run/index.js');\n",
    'aliased createRequire bound then called':
      "import { createRequire as cr } from 'node:module';\nconst q = cr(import.meta.url);\nexport const m = q('../run/index.js');\n",
    'const r = require': "const r = require;\nexport const m = r('../run/index.js');\n",
    'module.require': "export const m = module.require('../run/index.js');\n",
    'module["require"]': "export const m = module['require']('../run/index.js');\n",
    'percent-encoded folder': "import { x } from '../run%2Findex.js';\n",
  };
  for (const [name, text] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [RUN]: text }, UP));
  it('fails a non-literal specifier and says it cannot be checked', () => {
    fails({ [RUN]: 'export const m = (p) => import(p);\n' }, /non-literal specifier cannot be checked/);
    fails({ [RUN]: 'export const m = (p) => require(`../${p}/index.js`);\n' }, /non-literal specifier cannot be checked/);
    fails({ [RUN]: "export const m = (p) => import('../' + p);\n" }, /non-literal specifier cannot be checked/);
  });
  it('lets a test file use a non-literal specifier', () =>
    passes({ 'packages/core/test/a.test.ts': 'export const m = (p) => import(p);\n' }));
  it('lets an unrelated call through', () =>
    passes({ [RUN]: "const q = (x) => x;\nexport const m = q('../run/index.js');\n" }));
});

describe('check-arch bypass round: entry file reached through a directory', () => {
  const ENTRY = /may not import the entry file/;
  for (const spec of ['..', '../', '../../src', '../../src/', '../../src/.'])
    it(`fails import '${spec}' from a layer folder`, () =>
      fails({ 'packages/core/src/browser/a.ts': `import '${spec}';\n` }, ENTRY));
  it('fails import "." from a top-level non-entry file', () =>
    fails({ 'packages/core/src/config.ts': "import '.';\n" }, ENTRY));
  it('lets an entry file import the directory', () => passes({ 'packages/core/src/index.ts': "import '.';\n" }));
  it('fails core files outside src/ and test/ that import the entry file', () => {
    fails({ 'packages/core/lib/a.ts': "import '../src/index.js';\n" }, ENTRY);
    fails({ 'packages/core/lib/a.ts': "import '../src';\n" }, ENTRY);
  });
  it('applies the import rules to source files outside src/ and test/', () => {
    fails({ 'packages/core/lib/a.ts': "import '../../cli/src/a.js';\n" }, /leaves the package/);
    fails({ 'packages/core/bin/a.mjs': "import '@flowctl/cli';\n" }, /core may not depend on cli/);
    fails({ 'packages/core/lib/a.ts': "import '#x';\n" }, /package import/);
    fails({ 'packages/cli/bin/a.mjs': "import '../test/helper.js';\n" }, /imports test code/);
    fails({ 'packages/core/bin/a.mjs': 'export const m = (p) => import(p);\n' }, /non-literal specifier/);
  });
  it('treats a SRC directory in capitals as src', () =>
    fails({ 'packages/core/SRC/flow/a.ts': "import { d } from '../derive/index.js';\n" }, /may not import core\/derive/));
});
