/**
 * Architecture gate tests (imports): see check-arch.helpers.mjs for how the gate is run.
 */
import { describe, it } from 'node:test';
import { BOUNDARY, fails, passes } from './check-arch.helpers.mjs';

describe('check-arch nested relative imports', () => {
  it('a nested folder may import a sibling file two levels up in the same package', () =>
    passes({
      'packages/core/src/system1/adapters/llm/b.ts':
        "import { p } from '../../protocol.js';\nexport const b = p;\n",
    }));
  it('a nested folder may import a lower layer through its index', () =>
    passes({
      'packages/core/src/derive/match/a.ts':
        "import { o } from '../../observe/index.js';\nexport const a = o;\n",
    }));
  it('a nested folder may not import a higher layer', () =>
    fails(
      {
        'packages/core/src/observe/crawl/a.ts':
          "import { d } from '../../derive/index.js';\nexport const a = d;\n",
      },
      /may not import core\/derive/,
    ));
  it('a nested folder may not deep-import a lower layer', () =>
    fails(
      {
        'packages/core/src/derive/match/a.ts':
          "import { o } from '../../observe/crawl/page.js';\nexport const a = o;\n",
      },
      /through its index\.js/,
    ));
  it('a relative import that leaves the package fails', () =>
    fails(
      { 'packages/cli/src/a.ts': "import { x } from '../../core/src/index.js';\nexport const a = x;\n" },
      /leaves the package/,
    ));
  it('trust is below config', () =>
    fails(
      { 'packages/core/src/trust/a.ts': "import { c } from '../config/index.js';\nexport const a = c;\n" },
      /may not import core\/config/,
    ));
});

describe('check-arch layering sees every import spelling and is case-folded', () => {
  const FLOW = 'packages/core/src/flow/a.ts';
  const spellings = {
    'multi-line import': "import {\n  d,\n} from\n  '../derive/index.js';\n",
    'dynamic import': "const m = await import(\n  '../derive/index.js');\n",
    require: "const m = require('../derive/index.js');\n",
    'vi.mock': "vi.mock('../derive/index.js', () => ({}));\n",
    'second import on one line': "import a from './a.js'; import { d } from '../derive/index.js';\n",
    'case-folded target': "import { d } from '../Derive/index.js';\n",
  };
  for (const [name, text] of Object.entries(spellings))
    it(`fails: ${name}`, () => fails({ [FLOW]: text }, /may not import core\/derive/i));
  it('fails .tsx and .mts importers', () => {
    fails({ 'packages/core/src/flow/a.tsx': "import { d } from '../derive/index.js';\n" }, /may not import/);
    fails({ 'packages/core/src/flow/a.mts': "import { d } from '../derive/index.js';\n" }, /may not import/);
  });
  it('case-folds the importer directory', () =>
    fails(
      { 'packages/core/src/Flow/a.ts': "import { d } from '../derive/index.js';\n" },
      /may not import core\/derive/,
    ));
  it('fails a core folder with no layer', () =>
    fails({ 'packages/core/src/util/a.ts': 'export const a = 1;\n' }, /not in CORE_LAYERS/));
  it('fails an import of a core folder with no layer', () =>
    fails(
      { 'packages/core/src/flow/a.ts': "import { u } from '../util/index.js';\n" },
      /not in CORE_LAYERS/,
    ));
  it('fails a top-level core file with no layer', () =>
    fails({ 'packages/core/src/extra.ts': 'export const a = 1;\n' }, /not in CORE_LAYERS/));
  it('lets a folder import a lower top-level file and not a higher one', () => {
    passes({ 'packages/core/src/run/a.ts': "import { r } from '../result.js';\nexport const a = r;\n" });
    fails(
      { 'packages/core/src/flow/a.ts': "import { r } from '../result.js';\nexport const a = r;\n" },
      /may not import core\/result/,
    );
    fails(
      { 'packages/core/src/trust/a.ts': "import { c } from '../config.js';\nexport const a = c;\n" },
      /may not import/,
    );
  });
});

describe('check-arch generator-save tripwire', () => {
  const FORMS = {
    'plain name outside derive': 'export const f = saveAsGenerator;\n',
    concatenation: "const f = api['saveAs' + 'Generator'];\n",
    'unicode escape': "const f = api['\\u0073aveAsGenerator'];\n",
    'template literal': "const f = api[`saveAs${''}Generator`];\n",
  };
  for (const [name, text] of Object.entries(FORMS))
    it(`fails in a cli bin file: ${name}`, () =>
      fails({ 'packages/cli/bin/run.mjs': text }, /saveAsGenerator is internal/));
  it('fails in scripts and hooks', () => {
    fails({ 'scripts/x.mjs': 'export const f = saveAsGenerator;\n' }, /saveAsGenerator is internal/);
    fails({ '.claude/hooks/x.mjs': 'export const f = saveAsGenerator;\n' }, /saveAsGenerator is internal/);
  });
  it('fails when derive/index lists it, even though derive may use it', () => {
    fails(
      { 'packages/core/src/derive/index.ts': "export { saveAsGenerator } from './save-gen.js';\n" },
      /derive\/index must not list/,
    );
    passes({ 'packages/core/src/derive/writer.ts': 'export const f = saveAsGenerator;\n' });
  });
  it('fails when the package entry re-exports it', () =>
    fails(
      { 'packages/core/src/index.ts': "export { saveAsGenerator } from './derive/index.js';\n" },
      /saveAsGenerator is internal/,
    ));
});

describe('check-arch bypass round: encoded and hidden plugin names', () => {
  const ESC = '@acme/flowctl-\\u0070lugin-example';
  it('fails a JSON unicode escape in a dependency key', () =>
    fails({ 'packages/cli/package.json': `{"dependencies":{"${ESC}":"workspace:*"}}\n` }, BOUNDARY));
  it('fails a JSON unicode escape in a tsconfig reference path', () =>
    fails({ 'packages/cli/tsconfig.json': '{"references":[{"path":"../plugin\\u002dexample"}]}\n' }, BOUNDARY));
  it('fails an escaped name in JSON with comments', () =>
    fails({ 'packages/cli/tsconfig.json': `// note\n{"paths":{"x":["../plugin\\u002dexample"]}}\n` }, BOUNDARY));
  it('fails an escaped name in a yaml file', () =>
    fails({ 'packages/cli/a.yml': 'x: "plugin\\u002dexample"\n' }, BOUNDARY));
  it('fails a percent-encoded relative specifier outside src and test', () =>
    fails({ 'packages/cli/bin/x.mjs': "await import('../../plugin%2Dexample/src/index.js');\n" }, BOUNDARY));
  it('does not crash on a malformed percent escape', () =>
    passes({ 'packages/cli/bin/x.mjs': "await import('./100%.js');\n" }));
});
