/**
 * Architecture gate tests (late): see check-arch.helpers.mjs for how the gate is run.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BOUNDARY, GATE, PLUGIN, dirs, env, fails, passes, run } from './check-arch.helpers.mjs';

describe('check-arch round 4: comment scan', () => {
  const LONG = `${'./'.repeat(600)}../packages/plugin-example/x.d.ts`;
  const CASES = {
    'backslash before a newline does not swallow the real opener': `/* "\\\n import("${PLUGIN}") */\n`,
    'reference path longer than the bound': `/// <reference path="${LONG}" />\n`,
    'jsdoc @import longer than the bound': `/** @import {X} from '${LONG}' */\n`,
    'padded import type': `/* import("${'a/'.repeat(550)}../P/plugin-example") */\n`,
    'unterminated quote then the name': `/* "${PLUGIN} */\n`,
  };
  for (const [name, text] of Object.entries(CASES))
    it(`fails in a root wiring file: ${name}`, () => fails({ 'scripts/x.mjs': `${text}export const a = 1;\n` }, BOUNDARY));
  it('scans repeated import( and @import in linear time', () => {
    for (const unit of ['import("', '@import {X} from \'']) {
      const t0 = Date.now();
      const r = run({ 'packages/cli/bin/a.mjs': `/*${unit.repeat(Math.floor(600_000 / unit.length))}*/\nexport const a = 1;\n` });
      assert.ok(Date.now() - t0 < 8000, `${unit} took ${Date.now() - t0} ms`);
      assert.ok(r.status === 0 || r.status === 1, r.stderr);
    }
  });
});

describe('check-arch round 4: tab, LF and CR are stripped by Node', () => {
  const FLOW = 'packages/core/src/flow/a.ts';
  const NAMES = {
    'source escape tab': '\\t',
    'raw tab': '\t',
    'source escape LF': '\\n',
    'raw CR via escape': '\\r',
  };
  for (const [name, sep] of Object.entries(NAMES)) {
    const code = `await import("@acme/flowctl-pl${sep}ugin-example");\n`;
    for (const file of [FLOW, 'packages/cli/src/a.ts', 'packages/mcp/src/a.ts', 'scripts/x.mjs'])
      it(`fails a scoped name with ${name} in ${file}`, () => fails({ [file]: code }, BOUNDARY));
  }
  it('fails a bare and a relative name with a tab', () => {
    fails({ [FLOW]: 'await import("plug\\tin-example");\n' }, BOUNDARY);
    fails({ [FLOW]: 'await import("../../plugin-exa\\tmple/x.js");\n' }, BOUNDARY);
  });
  it('fails package.json keys with a tab, LF or CR', () => {
    for (const esc of ['\\t', '\\n', '\\r'])
      fails({ 'packages/cli/package.json': `{"dependencies":{"@acme/flowctl-pl${esc}ugin-example":"1"}}\n` }, BOUNDARY);
  });
  it('strips tab, LF and CR from a relative specifier before the layer check, and flags the control character', () => {
    for (const text of ['import "./\t../run/b.js";\n', 'export const m = import(`./\n../run/b.js`);\n', 'export const m = import(`./\r../run/b.js`);\n']) {
      const r = run({ [FLOW]: text });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, /may not import core\/run/);
      assert.match(r.stderr, /contains a control character/);
    }
  });
  it('flags an escaped tab in a relative specifier', () =>
    fails({ [FLOW]: 'import "./\\t../run/b.js";\n' }, /contains a control character/));
});

describe('check-arch round 4: layering outside src and through URLs', () => {
  const FLOW = 'packages/core/src/flow/a.ts';
  it('fails a core src import that resolves outside packages/core/src', () => {
    fails({ 'packages/core/src/flow/blib.js': "import '../../lib/x.js';\n" }, /resolves outside packages\/core\/src/);
    fails({ [FLOW]: "import '../../dist/index.js';\n" }, /resolves outside packages\/core\/src/);
  });
  it('fails a non-src core file that deep-imports a layer', () =>
    fails({ 'packages/core/lib/x.js': "import '../src/run/b.js';\n" }, /through its index\.js/));
  const URLS = {
    'new Worker(new URL)': "export const w = new Worker(new URL('../run/b.js', import.meta.url));\n",
    'new URL': "export const u = new URL('../run/b.js', import.meta.url);\n",
    'new Worker literal': "export const w = new Worker('../run/b.js');\n",
    fork: "export const f = fork('../run/b.js');\n",
    spawn: "export const s = spawn('node', ['../run/b.js']);\n",
  };
  for (const [name, text] of Object.entries(URLS)) it(`fails: ${name}`, () => fails({ [FLOW]: text }, /may not import core\/run/));
  it('applies URL specifiers to cli but not to test files', () => {
    fails({ 'packages/cli/src/a.ts': "export const u = new URL('../../core/src/x.js', import.meta.url);\n" }, /leaves the package/);
    passes({ 'packages/core/test/a.test.ts': "export const u = new URL('../../../docs/x.jsonl', import.meta.url);\n" });
  });
});

describe('check-arch round 4: module internals and exports', () => {
  const RUN = 'packages/core/src/browser/a.ts';
  const INDIRECT = /indirect module loader cannot be checked/;
  const M = "import M from 'node:module';\n";
  const CASES = {
    'Module._load': `${M}export const x = M._load('../run/index.js');\n`,
    _resolveFilename: `${M}export const x = M._resolveFilename;\n`,
    'Module.prototype.require': `${M}export const x = M.prototype.require;\n`,
    _extensions: `${M}export const x = M._extensions;\n`,
    'namespace member': "import * as N from 'node:module';\nexport const x = N._load;\n",
    'import.meta.require non-direct': 'export const x = [import.meta.require];\n',
    'exported destructured alias': 'export const { createRequire: mk } = await import("node:module");\n',
    'exported module destructure': "import M from 'node:module';\nexport const { createRequire: mk } = M;\n",
    'exported dynamic import': 'export const m = await import("node:module");\n',
    'export star': 'export * from "node:module";\n',
    'export default': `${M}export default M;\n`,
    'export specifier': `${M}export { M };\n`,
  };
  for (const [name, text] of Object.entries(CASES)) it(`fails: ${name}`, () => fails({ [RUN]: text }, INDIRECT));
  it('checks a direct import.meta.require call against the layers', () => {
    fails({ 'packages/core/src/flow/a.ts': "export const x = import.meta.require('../run/index.js');\n" }, /may not import core\/run/);
    fails({ 'packages/core/src/flow/a.ts': "const r = import.meta.require;\nexport const x = r('../run/index.js');\n" }, /may not import core\/run/);
  });
  it('still allows createRequire through the default import', () =>
    passes({ [RUN]: `${M}const r = M.createRequire(import.meta.url);\nexport const x = r('./y.js');\n` }));
  it('enforces indirect and eval in cli, mcp and fixture-app, not in tests', () => {
    for (const pkg of ['cli', 'mcp', 'fixture-app']) {
      fails({ [`packages/${pkg}/src/a.ts`]: 'export const m = [require];\n' }, INDIRECT);
      fails({ [`packages/${pkg}/src/a.ts`]: "export const m = eval('1');\n" }, /eval\/Function/);
    }
    passes({ 'packages/cli/test/a.test.ts': 'export const m = [require];\n' });
  });
});

describe('check-arch round 4: availability', () => {
  it('does not block on a FIFO', () => {
    const dir = mkdtempSync(join(tmpdir(), 'check-arch-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    mkdirSync(join(dir, 'packages/core/src/flow'), { recursive: true });
    writeFileSync(join(dir, 'packages/core/src/flow/f.ts'), 'export const a = 1;\n');
    execFileSync('git', ['add', '-A'], { cwd: dir, env });
    rmSync(join(dir, 'packages/core/src/flow/f.ts'));
    execFileSync('mkfifo', [join(dir, 'packages/core/src/flow/f.ts')]);
    const out = spawnSync('node', [GATE], { cwd: dir, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(out.status, 1, `${out.signal} ${out.stdout}${out.stderr}`);
    assert.match(out.stderr, /not a regular file/);
  });
});
