/**
 * Architecture gate tests (T0.13, env-input tripwire): see check-arch.helpers.mjs for how the gate is run.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ENV_BASELINE } from './env-input-baseline.mjs';
import { compareEnvBaseline, scanEnvReads } from './env-reads.mjs';
import { fails, passes, run } from './check-arch.helpers.mjs';

const FILE = 'packages/core/src/flow/a.ts';
const ENV = /blocked until T1\.14[\s\S]*ADR 0024 section 7[\s\S]*needs the owner/;
const BASELINE_FILE = 'scripts/env-input-baseline.mjs';

describe('check-arch env input gate: new paths fail', () => {
  const CASES = {
    'process.env.X': 'export const a = process.env.TOKEN;\n',
    'process.env[name]': 'export const a = (n: string) => process.env[n];\n',
    'Bun.env': 'export const a = Bun.env.TOKEN;\n',
    'import.meta.env': 'export const a = import.meta.env.TOKEN;\n',
    'alias': 'const e = process.env;\nexport const a = e.X;\n',
    'destructuring env': 'export const { X } = process.env;\n',
    "process['env']": "export const a = process['env'].X;\n",
    'template key': 'export const a = process[`env`].X;\n',
    "Reflect.get(process, 'env')": "export const a = Reflect.get(process, 'env');\n",
    'globalThis.process.env': 'export const a = globalThis.process.env.X;\n',
    'global.process?.env': 'export const a = global.process?.env;\n',
    'spread': 'export const a = { ...process.env };\n',
    'Object.entries': 'export const a = Object.entries(process.env);\n',
    'process aliased by destructuring': 'const { env } = process;\nexport const a = env.X;\n',
    'process as value': 'const p = process;\nexport const a = p;\n',
    'dynamic key on process': 'export const a = (k: string) => process[k];\n',
    'computed concatenation': "export const a = process['e' + 'nv'];\n",
    'parenthesised': 'export const a = (process as NodeJS.Process).env;\n',
    'import node:process named': "import { env } from 'node:process';\nexport const a = env;\n",
    'import node:process namespace': "import * as p from 'node:process';\nexport const a = p;\n",
    'require node:process': "export const a = require('node:process').env;\n",
    "'env' in input": "export const a = (s: object) => 'env' in s;\n",
    'hasOwn env': "export const a = (s: object) => Object.hasOwn(s, 'env');\n",
    'new env schema key': "import { z } from 'zod';\nexport const S = z.object({ env: z.string() });\n",
    'bun named env': "import { env } from 'bun';\nexport const a = env;\n",
    'bun namespace': "import * as B from 'bun';\nexport const a = B.env;\n",
    'bun default': "import B from 'bun';\nexport const a = B.env;\n",
    'process module renamed default': "import p from 'node:process';\nexport const a = p.env;\n",
    "'process' module name": "import { env } from 'process';\nexport const a = env;\n",
    'import equals require': "import p = require('node:process');\nexport const a = p;\n",
    'dynamic import': "export const a = import('node:process');\n",
    'self.process.env': 'export const a = (self as any).process.env.X;\n',
    'window.process.env': 'export const a = window.process.env.X;\n',
    'window.Bun.env': 'export const a = window.Bun.env.X;\n',
    'module.require': "export const a = module.require('node:process').env;\n",
    'import.meta.require': "export const a = import.meta.require('process');\n",
    'mainModule.require': "export const a = process.mainModule?.require('node:process');\n",
    'createRequire call': "import { createRequire } from 'node:module';\nexport const a = createRequire(import.meta.url)('node:process').env;\n",
    'getBuiltinModule': "export const a = process.getBuiltinModule('node:process');\n",
    'getBuiltinModule plain': "export const a = process.getBuiltinModule('process');\n",
    'hasOwnProperty on Object': "export const a = (s: object) => Object.hasOwnProperty(s, 'env');\n",
    'looseObject': 'export const S = z.looseObject({ env: z.string() });\n',
    'safeExtend': 'export const S = Base.safeExtend({ env: z.string() });\n',
    'computed literal key': "export const S = z.object({ ['env']: z.string() });\n",
    'parenthesised and cast shape': 'export const S = z.object(({ env: z.string() } as const) satisfies object);\n',
    'spread object with env': 'export const S = z.object({ ...{ env: z.string() } });\n',
    'shorthand env key': 'const env = z.string();\nexport const S = z.object({ env });\n',
    'destructured env': 'export const a = (s: { env: string }) => { const { env } = s; return env; };\n',
    'destructured env renamed': 'export const a = (s: { env: string }) => { const { env: e } = s; return e; };\n',
    'discriminator comparison': "export const a = (k: string) => k === 'env';\n",
    'quoted env schema key': "import { z } from 'zod';\nexport const S = z.strictObject({ 'env': z.string() });\n",
    'env key via extend': "import { z } from 'zod';\nexport const S = Base.extend({ env: z.string() });\n",
  };
  for (const [name, text] of Object.entries(CASES))
    it(`fails: ${name}`, () => fails({ [FILE]: text }, ENV));

  it('also fails in cli and mcp src', () => {
    fails({ 'packages/cli/src/a.ts': 'export const a = process.env.X;\n' }, ENV);
    fails({ 'packages/mcp/src/a.ts': 'export const a = process.env.X;\n' }, ENV);
  });
  it('names the file, the construct and the owner rule', () => {
    const r = run({ [FILE]: 'export const a = process.env.X;\n' });
    assert.match(r.stderr, /packages\/core\/src\/flow\/a\.ts:1 {2}process\.env: 1 found, baseline allows 0/);
    assert.match(r.stderr, /scripts\/env-input-baseline\.mjs needs the owner/);
  });
  it('a schema key fails in any package', () => {
    fails({ 'packages/cli/src/a.ts': "import { z } from 'zod';\nexport const S = z.object({ env: z.string() });\n" }, ENV);
  });
  it('pins the documented false positive: a parameter named process', () => {
    fails({ [FILE]: 'export const a = (process: { env: string }) => process.env;\n' }, ENV);
  });
});

describe('check-arch env input gate: allowed code', () => {
  const OK = {
    'static other members': 'export const a = [process.cwd(), process.platform, globalThis.fetch, typeof process];\n',
    'import.meta.url': 'export const a = import.meta.url;\n',
    'default import named process': "import process from 'node:process';\nexport const a = process.cwd();\n",
    'env in a string, comment and type': "/** process.env */\nexport const a = 'process.env';\nexport type E = NodeJS.ProcessEnv;\n",
    'binding element property name': 'export const a = (o: { process: number }) => { const { process: p } = o; return p; };\n',
    'type query': 'export type T = typeof process.env;\nexport type U = typeof process;\n',
    'getBuiltinModule of another module': "export const a = process.getBuiltinModule('node:fs');\n",
    'require of another module': "export const a = module.require('node:path');\n",
    'window property': 'export const a = window.location;\n',
    'object key env outside a schema call': 'export const a = { env: 1 };\n',
    'a property called process': 'export const a = (o: { process: number }) => o.process;\n',
  };
  for (const [name, text] of Object.entries(OK)) it(`passes: ${name}`, () => passes({ [FILE]: text }));
  it('does not scan test files', () => {
    passes({ 'packages/core/test/a.test.ts': 'export const a = process.env.X;\n' });
  });
});

describe('check-arch env input gate: baseline', () => {
  const SNIPPET = {
    'process.env': (i) => `export const e${i} = process.env;\n`,
    'schema key env': (i) => `export const e${i} = z.object({ env: 1 });\n`,
    "'env' in": (i) => `export const e${i} = (s: object) => 'env' in s;\n`,
  };
  const repoFor = (entries) => {
    const files = { [BASELINE_FILE]: 'export {};\n' };
    for (const b of entries)
      files[b.file] =
        (files[b.file] ?? '') + Array.from({ length: b.count }, (_, i) => SNIPPET[b.construct](i)).join('').replace(/e(\d)/g, `e${b.construct.length}$1`);
    return files;
  };
  it('every constructed baseline construct has a test snippet', () => {
    for (const b of ENV_BASELINE) assert.ok(SNIPPET[b.construct], b.construct);
  });
  it('the real baseline entries pass, with the stale check on', () => {
    const files = repoFor(ENV_BASELINE);
    const r = run(files);
    assert.equal(r.status, 0, r.stdout + r.stderr);
  });
  it('one more read in a baseline file fails', () => {
    const files = repoFor(ENV_BASELINE);
    files['packages/core/src/run/hooks.ts'] += 'export const extra = process.env.MORE;\n';
    const r = run(files);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /process\.env: 2 found, baseline allows 1/);
  });
  it('removing the code of a baseline entry makes the entry stale', () => {
    const files = repoFor(ENV_BASELINE);
    files['packages/core/src/system1/client.ts'] = 'export const a = 1;\n';
    const r = run(files);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /stale env baseline entry \(process\.env: baseline 1, found 0\)/);
    assert.match(r.stderr, /client\.ts/);
  });
  it('a repo with the baseline file and none of the code is stale for every entry', () => {
    const r = run({ [BASELINE_FILE]: 'export {};\n', 'packages/core/src/flow/a.ts': 'export const a = 1;\n' });
    assert.equal(r.status, 1);
    assert.equal((r.stderr.match(/stale env baseline entry/g) ?? []).length, ENV_BASELINE.length);
  });
  it('a repo without the baseline file skips the stale check', () => {
    passes({ 'packages/core/src/flow/a.ts': 'export const a = 1;\n' });
  });
});

describe('compareEnvBaseline', () => {
  const found = (n) => Array.from({ length: n }, (_, i) => ({ file: 'f.ts', construct: 'process.env', line: i + 1 }));
  const entry = (count) => [{ file: 'f.ts', construct: 'process.env', count, why: 'x' }];
  it('accepts findings up to the count', () => assert.deepEqual(compareEnvBaseline(found(2), entry(2), true), []));
  it('rejects more than the count', () => assert.equal(compareEnvBaseline(found(3), entry(2), true).length, 3));
  it('flags a stale entry only when asked', () => {
    assert.equal(compareEnvBaseline(found(1), entry(2), true).length, 1);
    assert.equal(compareEnvBaseline(found(1), entry(2), false).length, 0);
  });
  it('flags a duplicate entry', () => {
    assert.equal(compareEnvBaseline(found(1), [...entry(1), ...entry(1)], false).length, 1);
  });
  it('keys on file and construct, not line numbers', () => {
    const moved = scanEnvReads('f.ts', '\n\n\nexport const a = process.env;\n', { core: false });
    assert.deepEqual(compareEnvBaseline(moved.map((m) => ({ file: 'f.ts', ...m })), entry(1), true), []);
  });
});

describe('env-reads: each rule reports its own construct', () => {
  const constructs = (text) => scanEnvReads('f.ts', text).map((f) => f.construct);
  const CMP = ["compared with 'env'"];
  const MOD = ['process-module-import'];
  const CASES = [
    ["export * from 'bun';", MOD],
    ["export { env } from 'bun';", MOD],
    ["import process, { env } from 'node:process';", MOD],
    ["import process, { env } from 'process';", MOD],
    ["import type { env } from 'bun';", MOD],
    ["import process from 'bun';", MOD],
    ["import process from 'node:process';", []],
    ['const [env] = a;', []],
    ["k !== 'env';", CMP],
    ["k == 'env';", CMP],
    ["k != 'env';", CMP],
    ["'env' === k;", CMP],
    ["'env' != k;", CMP],
    ["switch (k) { case 'env': break; }", CMP],
    ["const { 'env': e } = o;", ["destructured 'env'"]],
    ["const { ['env']: e } = o;", ["destructured 'env'"]],
    ['const { env: e } = o;', ["destructured 'env'"]],
    ["const r = createRequire(u); r('node:process');", MOD],
    ["const r = createRequire(u); r('process');", MOD],
    ["const r = createRequire(u); r('bun');", MOD],
    ["const require = createRequire(import.meta.url); require('bun');", MOD],
    ["const r = require; r('bun');", MOD],
    ["const gb = process.getBuiltinModule; gb('node:process');", MOD],
    ["const r = createRequire(u); r('node:path');", []],
    ["(require)('bun');", MOD],
    ["require(('bun'));", MOD],
    ["x = process[('env')];", ['process.env']],
    ['x = process[`env`];', ['process.env']],
    ['x = process?.["env"];', ['process.env']],
    ['x = self.process?.env;', ['process.env']],
    ['x = (globalThis as any).process.env;', ['process.env']],
    ['x = (<NodeJS.Process>process).env;', ['process.env']],
    ['x = process!.env;', ['process.env']],
    ['x = (process as any)!.env;', ['process.env']],
    ['x = { process };', ['process-value']],
    ['x = globalThis.env;', []],
    ["x.hasOwnProperty('env');", ["hasOwn 'env'"]],
    ["hasOwn(x, 'env');", ["hasOwn 'env'"]],
    ["z.object({ [('env' as const)]: x });", ['schema key env']],
    ['z.object({ ...({ env }) });', ['schema key env']],
    ['z.object({ ...(<object>{ env: 1 }) });', ['schema key env']],
  ];
  for (const [text, expected] of CASES) it(text, () => assert.deepEqual(constructs(text), expected));
});
