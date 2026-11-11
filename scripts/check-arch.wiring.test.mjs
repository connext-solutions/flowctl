/**
 * Architecture gate tests (wiring): see check-arch.helpers.mjs for how the gate is run.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { BOUNDARY, GATE, PLUGIN, dirs, env, fails, passes, run } from './check-arch.helpers.mjs';

describe('check-arch plugin boundary: wiring and other file kinds fail', () => {
  for (const file of [
    'packages/core/src/view.jsx',
    'packages/core/src/page.html',
    'packages/core/src/App.vue',
    'packages/cli/src/bin-wrapper',
    'packages/core/config.json5',
    'tsconfig.base.json',
    'tsconfig.tests.json',
    'vitest.workspace.ts',
    'package.json',
    'scripts/build.mjs',
    'Dockerfile',
    '.github/workflows/ci.yml',
  ])
    it(`fails in ${file}`, () =>
      fails({ [file]: `#!/usr/bin/env node\nimport x from "${PLUGIN}"\n"${PLUGIN}"\n` }, BOUNDARY));

  it('allows the root tsconfig.json reference and the lockfile', () =>
    passes({
      'tsconfig.json': '{"references":[{"path":"packages/plugin-example"}]}\n',
      'bun.lock': `"${PLUGIN}": ["${PLUGIN}@workspace:packages/plugin-example"]\n`,
    }));

  it('knows a plugin by the name in its package.json', () =>
    fails(
      {
        'packages/plugin-other/package.json': '{"name":"@acme/odd-name"}\n',
        'packages/core/src/flow/a.ts': "import x from '@acme/odd-name';\n",
      },
      BOUNDARY,
    ));

  it('fails on a gitlink or unreadable entry instead of skipping it', () => {
    const r = run({ 'packages/core/src/flow/ok.ts': 'export const a = 1;\n' });
    assert.equal(r.status, 0);
    const dir = mkdtempSync(join(tmpdir(), 'check-arch-'));
    dirs.push(dir);
    execFileSync('git', ['init', '-q'], { cwd: dir, env });
    mkdirSync(join(dir, 'packages/core/src/sub'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: join(dir, 'packages/core/src/sub'), env });
    writeFileSync(join(dir, 'packages/core/src/sub/a.ts'), `import x from '${PLUGIN}';\n`);
    const out = spawnSync('node', [GATE], { cwd: dir, env, encoding: 'utf8' });
    assert.equal(out.status, 1, out.stdout + out.stderr);
    assert.match(out.stderr, /cannot read/);
  });
});

describe('check-arch file listing and decoding', () => {
  const BAD = `import x from '${PLUGIN}';\n`;
  for (const name of ['\u00e9.ts', 'a"b.ts', 'a\\b.ts', 'sp ace.ts'])
    it(`scans a file named ${JSON.stringify(name)}`, () =>
      fails({ [`packages/core/src/${name}`]: BAD }, BOUNDARY));

  it('scans a source file that contains a NUL byte', () =>
    fails({ 'packages/core/src/flow/a.ts': Buffer.from(`\0${BAD}`) }, BOUNDARY));
  it('applies the line cap to a source file with a NUL byte', () =>
    fails(
      { 'packages/core/src/flow/a.ts': Buffer.from(`\0${'export const a = 1;\n'.repeat(301)}`) },
      /lines \(max/,
    ));
  it('decodes a UTF-16 file instead of skipping it', () =>
    fails(
      { 'packages/core/src/flow/a.ts': Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(BAD, 'utf16le')]) },
      BOUNDARY,
    ));
  it('fails on an unknown binary file', () =>
    fails({ 'packages/core/blob.dat': Buffer.from([1, 0, 0, 2]) }, /unknown binary/));
  it('skips a known binary extension', () =>
    passes({ 'packages/core/logo.png': Buffer.from([1, 0, 2, 0]) }));

  it('fails from a subdirectory instead of passing on nothing', () =>
    fails({ 'packages/core/src/sub/a.ts': BAD }, BOUNDARY, undefined));
  it('resolves the repository root when run from a subdirectory', () => {
    const r = run({ 'packages/core/src/flow/a.ts': BAD }, {}, 'packages/core/src');
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, BOUNDARY);
  });
  it('fails on an empty file list', () => {
    const r = run({});
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /no files found/);
  });
});

describe('check-arch plugin boundary: glob, pipe and wiring spellings', () => {
  const cases = {
    'Dockerfile glob': ['Dockerfile', 'COPY packages/plugin-*/ /app/\n'],
    'shell pipe': ['scripts/run.sh', 'echo a|plugin-example\n'],
    ampersand: ['scripts/run.sh', 'cmd&plugin-example\n'],
    'gate-like name with a suffix': ['scripts/check-arch-x.sh', `${PLUGIN}\n`],
    'scripts/lib': ['scripts/lib/a.mjs', `import "${PLUGIN}";\n`],
    'workflow action': ['.github/actions/a/action.yml', `run: ${PLUGIN}\n`],
    bunfig: ['bunfig.toml', `x = "${PLUGIN}"\n`],
    Makefile: ['Makefile', `build:\n\techo ${PLUGIN}\n`],
  };
  for (const [name, [file, text]] of Object.entries(cases))
    it(`fails: ${name}`, () => fails({ [file]: text }, BOUNDARY));
});
