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

describe('check-arch: reconcile never starts a process (ADR 0035)', () => {
  const FILE = 'packages/core/src/reconcile/code/a.ts';
  const SPAWN = /reconcile never starts a process/;
  const CASES = {
    'node: import': "import { execFileSync } from 'node:child_process';\nexport const a = execFileSync;\n",
    'bare import': "import * as cp from 'child_process';\nexport const a = cp;\n",
    'dynamic import': "export const a = () => import('node:child_process');\n",
    require: "export const a = require('child_process');\n",
  };
  for (const [name, text] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [FILE]: text }, SPAWN));
  it('lets another core folder import it', () =>
    passes({ 'packages/core/src/trust/a.ts': "import { spawn } from 'node:child_process';\nexport const a = spawn;\n" }));
});

describe('check-arch: contract readers never start a process (ADR 0040)', () => {
  const FILE = 'packages/core/src/derive/contract/a.ts';
  const SPAWN = /never starts a process/;
  const CASES = {
    'node: import': "import { execFileSync } from 'node:child_process';\nexport const a = execFileSync;\n",
    'bare import': "import * as cp from 'child_process';\nexport const a = cp;\n",
    'dynamic import': "export const a = () => import('node:child_process');\n",
    require: "export const a = require('child_process');\n",
  };
  for (const [name, text] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [FILE]: text }, SPAWN));
  it('lets the rest of derive and its tests import it', () => {
    passes({ 'packages/core/src/derive/match/a.ts': "import { spawn } from 'node:child_process';\nexport const a = spawn;\n" });
    passes({ 'packages/core/test/derive/a.test.ts': "import { spawn } from 'node:child_process';\nexport const a = spawn;\n" });
  });
});

describe('check-arch: escapes past the last code point', () => {
  it('passes a file holding \\u{110000} instead of crashing', () =>
    passes({ 'packages/core/test/a.test.ts': "export const a = '\\\\u{110000}';\n" }));
});
