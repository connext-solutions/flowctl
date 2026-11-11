/**
 * Architecture gate tests (layers): see check-arch.helpers.mjs for how the gate is run.
 */
import { describe, it } from 'node:test';
import { BOUNDARY, PLUGIN, fails, passes } from './check-arch.helpers.mjs';

describe('check-arch second mechanical pass', () => {
  const BAD = `import x from '${PLUGIN}';\n`;
  const FLOW = 'packages/core/src/flow/a.ts';
  it('fails a path containing a newline, carriage return or tab', () => {
    fails({ 'packages/core/src/flow/a\nb.ts': BAD }, /control character/);
    fails({ 'packages/core/src/flow/a\rb.ts': BAD }, /control character/);
    fails({ 'packages/core/src/flow/a\tb.ts': BAD }, /control character/);
  });
  it('fails a self-reference by package name in src and in test', () => {
    fails({ [FLOW]: "import { x } from '@flowctl/core';\n" }, /self-reference/);
    fails({ 'packages/core/test/a.test.ts': "import { x } from '@flowctl/core';\n" }, /self-reference/);
  });
  it('fails createRequire bound then called, #imports, absolute and file: specifiers', () => {
    fails(
      { [FLOW]: "const req = createRequire(import.meta.url);\nconst d = req('../derive/index.js');\n" },
      /may not import core\/derive/,
    );
    fails({ [FLOW]: "import x from '#internal/x';\n" }, /package import/);
    fails({ [FLOW]: "import x from '/etc/x.js';\n" }, /absolute import/);
    fails({ [FLOW]: "import x from 'file:///etc/x.js';\n" }, /absolute import/);
    fails({ [FLOW]: "const m = await import.meta.resolve('../derive/index.js');\n" }, /may not import core\/derive/);
  });
  it('fails src importing test code', () =>
    fails({ [FLOW]: "import { t } from '../../test/helper.js';\n" }, /src imports test code/));
  it('checks the imports of top-level core files against their layer', () => {
    fails({ 'packages/core/src/config.ts': "import { f } from './flow/index.js';\nexport const c = f;\n" }, /may not import core\/flow/);
    fails({ 'packages/core/src/safe-fs.ts': "import { r } from './result.js';\nexport const s = r;\n" }, /may not import core\/result/);
    passes({ 'packages/core/src/result.ts': "import type { A } from './flow/index.js';\nexport type R = A;\n" });
    passes({ 'packages/core/src/safe-fs.ts': "import { C } from './config.js';\nexport const s = C;\n" });
    passes({ 'packages/core/src/save.ts': "import { f } from './flow/index.js';\nexport const s = f;\n" });
  });
  it('does not crash on folders named like Object.prototype members', () => {
    fails({ 'packages/core/src/constructor/a.ts': 'export const a = 1;\n' }, /not in CORE_LAYERS/);
    fails({ 'packages/toString/src/a.ts': 'export const a = 1;\n' }, /unknown package/);
  });
  it('counts CRLF, lone CR and U+2028 as line breaks for the cap and the comment rule', () => {
    const body = 'export const a = 1;';
    const many = Array.from({ length: 301 }, () => body);
    fails({ [FLOW]: many.join('\r\n') }, /lines \(max/);
    fails({ [FLOW]: many.join('\r') }, /lines \(max/);
    fails({ [FLOW]: many.join('\u2028') }, /lines \(max/);
    fails({ [FLOW]: `${body}\r\n// a comment\r\n` }, /inline comment/);
    fails({ [FLOW]: `${body}\r// a comment\r` }, /inline comment/);
  });
  it('finds comments with the TypeScript scanner: after code and in blocks, never in strings, regexes or templates (#38)', () => {
    fails({ [FLOW]: 'export const a = 1; // why\n' }, /inline comment/);
    fails({ [FLOW]: 'export const a = /* why */ 1;\n' }, /inline comment/);
    fails({ [FLOW]: 'export const f = () => {\n  return 1; // why\n};\n' }, /a\.ts:2 +inline comment/);
    passes({ [FLOW]: "export const u = 'http://x//y';\n" });
    passes({ [FLOW]: 'export const r = /^https?:\\/\\//;\n' });
    passes({ [FLOW]: 'export const t = `a\n// not a comment\nb`;\n' });
    passes({ [FLOW]: '/**\n * e.g. f(); // two commands\n */\nexport const a = 1;\n' });
    passes({ [FLOW]: 'export const a = 1; /** @see x */\n' });
    passes({ [FLOW]: '// oxlint-disable-next-line no-x -- reason\nexport const a = 1; // dup-ok: why\n' });
  });
  it('decodes UTF-16 without a BOM instead of passing it', () => {
    fails({ [FLOW]: Buffer.from(BAD, 'utf16le') }, BOUNDARY);
    fails({ [FLOW]: Buffer.from(BAD, 'utf16le').swap16() }, BOUNDARY);
  });
  it('does not mistake ordinary calls for module loads', () => {
    passes({
      [FLOW]:
        "import path from 'node:path';\nexport const a = path.resolve('..', '..', '..', 'x');\nexport const b = registry.mock('../../..');\n",
    });
  });
  it('lets a layer folder import its own directory', () => {
    passes({ 'packages/core/src/run/a.ts': "import '.';\n" });
  });
});

describe('check-arch core layers', () => {
  it('derive may import observe', () =>
    passes({
      'packages/core/src/derive/a.ts': "import { o } from '../observe/index.js';\nexport const a = o;\n",
    }));
  it('flow may not import derive', () =>
    fails(
      { 'packages/core/src/flow/a.ts': "import { d } from '../derive/index.js';\nexport const a = d;\n" },
      /may not import core\/derive/,
    ));
  it('observe may not import derive', () =>
    fails(
      { 'packages/core/src/observe/a.ts': "import { d } from '../derive/index.js';\nexport const a = d;\n" },
      /may not import core\/derive/,
    ));
});

describe('check-arch generator-save boundary', () => {
  it('fails a reference outside derive and save', () =>
    fails(
      { 'packages/cli/src/a.ts': "import { saveAsGenerator } from './x.js';\nexport const a = saveAsGenerator;\n" },
      /saveAsGenerator is internal/,
    ));
  it('allows derive and the save entry', () => {
    passes({ 'packages/core/src/derive/a.ts': 'export const a = saveAsGenerator;\n' });
    passes({ 'packages/core/src/save.ts': 'export const a = saveAsGenerator;\n' });
  });
  it('provenance sits between observe and derive', () =>
    fails(
      { 'packages/core/src/provenance/a.ts': "import { d } from '../derive/index.js';\nexport const a = d;\n" },
      /may not import core\/derive/,
    ));
});
