/**
 * Architecture gate tests (boundary-source): see check-arch.helpers.mjs for how the gate is run.
 */
import { describe, it } from 'node:test';
import { BOUNDARY, PLUGIN, fails, passes } from './check-arch.helpers.mjs';

describe('check-arch plugin boundary: source bypasses fail', () => {
  const CASES = {
    'static import': `import { x } from '${PLUGIN}';\n`,
    'relative path into the plugin': "import { x } from '../../plugin-example/src/index.js';\n",
    'path from the repo root': "export * from 'packages/plugin-example';\n",
    'bare directory name': "import 'plugin-example';\n",
    'multi-line import': `import {\n  a,\n  b,\n} from\n  '${PLUGIN}';\n`,
    'multi-line dynamic import': `const m = await import(\n  '${PLUGIN}',\n);\n`,
    require: `const m = require('${PLUGIN}');\n`,
    createRequire: `const m = createRequire(import.meta.url)(\n  '${PLUGIN}');\n`,
    'import equals': `import x = require('${PLUGIN}');\n`,
    'template literal': `const m = await import(\`${PLUGIN}\`);\n`,
    'vi.mock': `vi.mock('${PLUGIN}', () => ({}));\n`,
    'vi.importActual': `const m = await vi.importActual('${PLUGIN}');\n`,
    'second import on the same line': `import a from './a.js'; import b from '${PLUGIN}';\n`,
    'type re-export': `export type { T } from '${PLUGIN}';\n`,
    'second half of a split literal': "const n = '@acme/flowctl-' + 'plugin-example';\n",
    'upper-case spelling': `import x from '${PLUGIN.toUpperCase()}';\n`,
  };
  for (const [name, text] of Object.entries(CASES))
    it(`core src: ${name}`, () => fails({ 'packages/core/src/flow/a.ts': text }, BOUNDARY));

  for (const file of [
    'packages/core/test/a.test.ts',
    'packages/cli/src/a.ts',
    'packages/fixture-app/src/a.ts',
    'packages/mcp/src/a.ts',
    'packages/core/src/a.d.ts',
    'packages/core/src/a.mts',
    'packages/core/src/a.cjs',
    'packages/core/vitest.config.ts',
    'packages/cli/src/ui.tsx',
  ])
    it(`fails in ${file}`, () => fails({ [file]: `import x from '${PLUGIN}';\n` }, BOUNDARY));

  it('fails a javascript file in a plugin-free package', () =>
    fails({ 'packages/core/scripts/a.mjs': `import x from '${PLUGIN}';\n` }, BOUNDARY));
});

describe('check-arch plugin boundary: manifests and configs fail', () => {
  it('package.json dependency', () =>
    fails(
      { 'packages/core/package.json': `{"dependencies":{"${PLUGIN}":"workspace:*"}}\n` },
      BOUNDARY,
    ));
  it('tsconfig reference', () =>
    fails(
      { 'packages/cli/tsconfig.json': '{"references":[{"path":"../plugin-example"}]}\n' },
      BOUNDARY,
    ));
  it('tsconfig paths', () =>
    fails(
      { 'packages/core/tsconfig.json': `{"compilerOptions":{"paths":{"x":["../plugin-example/src"]}}}\n` },
      BOUNDARY,
    ));
  it('tracked symlink', () =>
    fails({ 'packages/core/src/flow/ok.ts': 'export const a = 1;\n' }, /symbolic link/, {
      'packages/core/src/flow/link.ts': 'ok.ts',
    }));
});

describe('check-arch plugin boundary: legitimate code passes', () => {
  it('a plugin that imports core', () =>
    passes({
      'packages/plugin-example/src/a.ts':
        "import { x } from '@flowctl/core';\nexport const y = x;\n",
    }));
  it('a plugin that names itself', () =>
    passes({ 'packages/plugin-example/package.json': `{"name":"${PLUGIN}"}\n` }));
  it('core code that mentions no plugin', () =>
    passes({ 'packages/core/src/flow/a.ts': "import { b } from './b.js';\nexport const a = b;\n" }));
  it('a third-party package called plugin-react', () =>
    passes({
      'packages/core/src/flow/a.ts': "import react from '@vitejs/plugin-react';\nexport const a = react;\n",
      'packages/core/package.json': '{"devDependencies":{"@vitejs/plugin-react":"^5.0.0"}}\n',
    }));
  it('a comment that names the plugin is not an import', () =>
    passes({
      'packages/core/src/flow/a.ts': `/** See ${PLUGIN} for the adapter. */\nexport const a = 1;\n`,
    }));
});
