/**
 * Driver run inside the traced child of `check-bundle-plugins.mjs` (flags: `--experimental-import-meta-resolve`,
 * and `--conditions <name>` for a pass with one extra condition).
 * Imports the entry points of one package the way a consumer would, so Node itself resolves them
 * (`exports` conditions, arrays, `main`), then tells the hook that every import settled.
 *
 * @remarks argv: package directory, JSON array of subpaths (`"."`, `"./extra"`), JSON array of modes
 * (`"import"`: ESM `import()`; `"require"`: CommonJS `require()` resolved with the `require` condition).
 * An import that fails, a target that leaves the package, or a `.ts` target (not built) throws, so the
 * run exits non-zero. If the entry never settles, or the process exits early, the `done` marker is
 * missing and the parent fails.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [dir, specsJson, modesJson] = process.argv.slice(2);
const name = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8').replace(/^﻿/, '')).name;
const base = pathToFileURL(join(dir, 'index.mjs')).href;
const req = createRequire(base);

const resolveEntry = (sub) => {
  const spec = name + sub.slice(1);
  try {
    return import.meta.resolve(spec, base);
  } catch (e) {
    if (sub !== '.') throw e;
    return pathToFileURL(req.resolve(dir)).href;
  }
};
const guard = (url, sub) => {
  const file = url.startsWith('file:') ? fileURLToPath(url) : '';
  if (!file.startsWith(dir + sep)) throw new Error(`entry ${sub} resolves outside the package (${url})`);
  if (/\.[cm]?tsx?$/i.test(file)) throw new Error(`entry ${sub} is TypeScript source, not built output (${file})`);
};

const modes = JSON.parse(modesJson);
for (const sub of JSON.parse(specsJson)) {
  if (modes.includes('import')) {
    const url = resolveEntry(sub);
    guard(url, sub);
    await import(url);
  }
  if (modes.includes('require')) {
    const file = req.resolve(name + sub.slice(1));
    guard(pathToFileURL(file).href, sub);
    req(file);
  }
}
globalThis[Symbol.for('flowctl.bundle-load-hook')].done();
