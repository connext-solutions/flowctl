/**
 * Tests for `check-bundle-plugins.mjs` (T0.16), part 3: Workers inside traced descendants.
 */
import { describe, it } from 'node:test';
import { PLUGIN, fails, inA, passes } from './check-bundle-plugins.helpers.mjs';

const WORKER = (c, opt = '') =>
  `import { Worker } from 'node:worker_threads';\nawait new Promise((r) => new Worker(${JSON.stringify(`import ${JSON.stringify(c.P)}`)}, { eval: true${opt} }).on('exit', r));\n`;
/** Code run by a descendant that starts a Worker importing the plugin. */
const descendantCode = (c, opt = '') => `const { Worker } = require('node:worker_threads'); new Worker(${JSON.stringify(`import(${JSON.stringify(c.P)})`)}, { eval: true${opt} });`;

describe('check-bundle-plugins: Workers in traced descendants', () => {
  it('a fork()ed child (fd 3 is its IPC socket) whose Worker imports a plugin', () =>
    fails(
      inA(
        (c) =>
          `import { fork } from 'node:child_process';\nimport { writeFileSync } from 'node:fs';\nimport { join } from 'node:path';\nconst f = join(${JSON.stringify(c.dir)}, 'child.cjs');\nwriteFileSync(f, ${JSON.stringify(descendantCode(c))});\nawait new Promise((r) => fork(f).on('exit', r));\nexport {};\n`,
      ),
      PLUGIN,
    ));
  it('a child spawned with a pipe on fd 3 whose Worker imports a plugin', () =>
    fails(
      inA(
        (c) =>
          `import { spawnSync } from 'node:child_process';\nspawnSync(${JSON.stringify(c.node)}, ['-e', ${JSON.stringify(descendantCode(c))}], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] });\nexport {};\n`,
      ),
      PLUGIN,
    ));
  it('a Worker with env: {} inside a descendant, importing a plugin', () =>
    fails(
      inA(
        (c) =>
          `import { spawnSync } from 'node:child_process';\nspawnSync(${JSON.stringify(c.node)}, ['-e', ${JSON.stringify(descendantCode(c, ', env: {}'))}]);\nexport {};\n`,
      ),
      PLUGIN,
    ));
  it('a descendant whose own exit handler loads a module does not hit a closed trace descriptor', () =>
    passes((c) => ({
      'core/dist/flow/c.cjs': 'module.exports = 1;\n',
      ...inA(
        () =>
          `import { spawnSync } from 'node:child_process';\nconst r = spawnSync(${JSON.stringify(c.node)}, ['-e', ${JSON.stringify(`process.on('exit', () => require(${JSON.stringify(c.at('core/dist/flow/c.cjs'))}))`)}], { encoding: 'utf8' });\nif (r.status !== 0) throw new Error('descendant failed: ' + r.stderr);\nexport {};\n`,
      )(c),
    })));
  it('a clean Worker with env: {} in the entry still works (legit use)', () =>
    passes(inA(() => "import { Worker } from 'node:worker_threads';\nawait new Promise((r) => new Worker('1 + 1', { eval: true, env: {} }).on('exit', r));\nexport {};\n")));
  it('a clean Worker in a descendant still works', () =>
    passes(
      inA(
        (c) =>
          `import { spawnSync } from 'node:child_process';\nspawnSync(${JSON.stringify(c.node)}, ['-e', "new (require('node:worker_threads').Worker)('1 + 1', { eval: true, env: {} })"]);\nexport {};\n`,
      ),
    ));
  it('the Worker with env: {} in the entry that imports a plugin is still found', () => fails(inA((c) => WORKER(c, ', env: {}')), PLUGIN));
});
