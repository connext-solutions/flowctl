/**
 * Architecture gate tests (driver construction, T5.1): see check-arch.helpers.mjs for how the gate is run.
 */
import { describe, it } from 'node:test';
import { fails, passes } from './check-arch.helpers.mjs';

const FACTORY = 'packages/core/src/system1/client.ts';
const CLASS = 'packages/core/src/system1/jev.ts';
const OUTSIDE = /outside the driver factory/;
const DECL = 'export class JevDriver {}\n';

describe('check-arch: System 1 drivers are built only by the factory (ADR 0022)', () => {
  it('lets the factory construct the driver its class file declares', () =>
    passes({
      [CLASS]: DECL,
      [FACTORY]: "import { JevDriver } from './jev.js';\nexport const d = () => new JevDriver();\n",
    }));
  const CASES = {
    'new in another core folder': [
      'packages/core/src/explore/a.ts',
      "import { JevDriver } from '../system1/jev.js';\nexport const d = new JevDriver();\n",
    ],
    'new in the class file itself': [CLASS, `${DECL}export const d = new JevDriver();\n`],
    'parenthesised new': ['packages/core/src/system1/b.ts', 'export const d = () => new (FooDriver)();\n'],
    'Reflect.construct': ['packages/core/src/system1/b.ts', 'export const d = Reflect.construct(OtherDriver, []);\n'],
    'a subclass': ['packages/core/src/system1/b.ts', 'export class Mine extends BaseDriver {}\n'],
    'an alias of the class': ['packages/core/src/system1/b.ts', "import { JevDriver as J } from './jev.js';\nexport const K = J;\n"],
    're-export from an index': ['packages/core/src/system1/index.ts', "export { JevDriver } from './jev.js';\n"],
    'construction in cli': ['packages/cli/src/a.ts', 'export const d = new LlmDriver();\n'],
    'construction in a bin file': ['packages/mcp/bin/a.mjs', 'export const d = new LlmDriver();\n'],
  };
  for (const [name, [file, text]] of Object.entries(CASES))
    it(`fails: ${name}`, () => fails({ [CLASS]: DECL, [file]: text }, OUTSIDE));
  it('ignores comments and strings that name the class', () =>
    passes({
      [CLASS]: DECL,
      'packages/core/src/explore/a.ts': "/** Never `new JevDriver()`; see createDriver. */\nexport const s = 'new JevDriver()';\n",
    }));
  it('lets tests construct a driver (refused at run time by every entry point)', () =>
    passes({
      [CLASS]: DECL,
      'packages/core/test/a.test.ts': "import { JevDriver } from '../src/system1/jev.js';\nexport const d = new JevDriver();\n",
    }));
});
