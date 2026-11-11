/**
 * Rules of the T0.16 load check, applied to the events of one traced run (see `check-bundle-plugins.mjs`).
 *
 * @remarks Paths are canonicalised with `realpathSync.native` and, on macOS and Windows (case-insensitive
 * file systems), case-folded before any prefix comparison. Rules, per loaded module:
 * - a plugin file (`packages/plugin-*`, or `node_modules/@acme/flowctl-plugin-*`) fails;
 * - a file outside `packages/<package>/dist` and outside the repo's root `node_modules` fails (a plugin
 *   copied to a temp folder, or any hand-placed file); in the root `node_modules` only a package that a
 *   workspace package.json declares, or the lockfile lists, may load (`packages/*\/node_modules` fails);
 * - a `dist` file with no counterpart under the package's `src` fails: this catches accidents, an empty
 *   `src` stub defeats it;
 * - core layering: a core `dist` module may not load a higher layer or an entry file, and its folder must
 *   be in `CORE_LAYERS` (the list `check-arch.mjs` uses).
 * A `data:` module is attributed to the file that imported it. Malformed events are the caller's concern.
 */
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry, layerName, layerOf } from './core-layers.mjs';

const FOLD = process.platform === 'darwin' || process.platform === 'win32';
export const norm = (p) => (FOLD ? p.toLowerCase() : p);
const SCOPED_PLUGIN = /[\\/]node_modules[\\/](?:@[^\\/]+[\\/])?[^\\/]*flowctl-plugin-/i;
const SRC_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

export const canonical = (p) => {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
};
export const toPath = (url) => {
  if (typeof url !== 'string' || !url.startsWith('file:')) return undefined;
  try {
    return canonical(fileURLToPath(url));
  } catch {
    return undefined;
  }
};

/**
 * @param {string} name label for messages
 * @param {Array<object>} events parsed, validated events
 * @param {{root: string, exempt: Set<string>, declared: Set<string>}} env canonical repo root, exact files
 * the check itself loads, and the package names workspace package.json files and the lockfile declare
 * @returns {string[]} problems
 */
export const analyse = (name, events, { root, exempt, declared }) => {
  const problems = [];
  const pk = norm(`${root}${sep}packages${sep}`);
  const rootNm = norm(`${root}${sep}node_modules${sep}`);
  const packageUnder = (rest) => {
    const segs = rest.split(sep);
    const at = segs.lastIndexOf('node_modules') + 1;
    const [a = '', b = ''] = segs.slice(at);
    return a.startsWith('@') ? `${a}/${b}` : a;
  };
  const rootN = norm(root + sep);
  const coreDist = norm(`${root}${sep}packages${sep}core${sep}dist${sep}`);
  const rel = (p) => (norm(p).startsWith(rootN) ? p.slice(rootN.length).split(sep).join('/') : p);
  const label = (url) => {
    if (url === null || url === undefined) return '(a child process or worker entry)';
    const p = toPath(url);
    if (p !== undefined) return rel(p);
    return typeof url === 'string' && url.startsWith('data:') ? `data:${url.slice(5, 40)}...` : String(url);
  };
  const dataParent = new Map();
  for (const e of events)
    if (e.t === 'edge' && e.to.startsWith('data:') && e.from !== null && !dataParent.has(e.to)) dataParent.set(e.to, e.from);
  const edgeTargets = new Set(events.flatMap((e) => (e.t === 'edge' ? [e.to] : [])));
  const owner = (url) => {
    const seen = new Set();
    let u = url;
    while (typeof u === 'string' && u.startsWith('data:') && !seen.has(u)) {
      seen.add(u);
      u = dataParent.get(u);
    }
    return u;
  };
  const fail = (importer, importee, why) => problems.push(`${name}: ${label(importer)} -> ${label(importee)}  ${why}`);
  const corePartsOf = (url) => {
    const p = toPath(url);
    return p !== undefined && norm(p).startsWith(coreDist) ? p.slice(coreDist.length).split(sep) : undefined;
  };
  const isPlugin = (p) => (norm(p).startsWith(pk) && /^plugin-/i.test(p.slice(pk.length))) || SCOPED_PLUGIN.test(p);
  const hasSource = (p) => {
    const m = /^([^/\\]+)[/\\]dist[/\\]([\s\S]+)$/.exec(p.slice(pk.length));
    if (m === null) return true;
    const stem = m[2].replace(/\.[^./\\]+$/, '');
    return SRC_EXT.some((x) => existsSync(`${root}${sep}packages${sep}${m[1]}${sep}src${sep}${stem}${x}`));
  };
  const checkedFile = new Set();
  const checkFile = (importer, url) => {
    if (typeof url !== 'string' || url.startsWith('data:')) return;
    const p = toPath(url);
    if (p === undefined) {
      fail(importer, url, 'is not a file: or data: module; it cannot be checked');
      return;
    }
    const key = `${importer}>${norm(p)}`;
    if (checkedFile.has(key)) return;
    checkedFile.add(key);
    if (isPlugin(p)) return fail(importer, url, 'loads a plugin; plugins depend on core, never the reverse (ADR 0023)');
    if (exempt.has(norm(p))) return;
    if (norm(p).startsWith(rootNm)) {
      const name = packageUnder(p.slice(rootNm.length));
      if (!declared.has(name))
        fail(importer, url, `is in node_modules, but package "${name}" is declared by no workspace package.json and is not in the lockfile`);
      return;
    }
    const inDist = norm(p).startsWith(pk) && /^[^/\\]+[/\\]dist[/\\]/.test(p.slice(pk.length));
    if (!inDist) return fail(importer, url, 'is outside packages/*/dist and the root node_modules; only built output may load');
    if (!hasSource(p)) fail(importer, url, 'is a dist file with no source under the package src (an accident check: an empty src stub defeats it)');
  };

  for (const e of events) {
    if (e.t === 'hooks') {
      problems.push(`${name}: ${e.from ?? 'unknown caller'} registered module hooks via ${e.api}; hooks can hide what is loaded`);
      continue;
    }
    if (e.t === 'done') continue;
    if (e.t === 'load') {
      if (!edgeTargets.has(e.url)) checkFile('a module hook', e.url);
      continue;
    }
    const importer = owner(e.from);
    checkFile(importer ?? e.from, e.to);
    const from = corePartsOf(importer);
    const to = corePartsOf(e.to);
    if (from === undefined || to === undefined || isEntry(from)) continue;
    const fromName = layerName(from);
    const toName = layerName(to);
    if (isEntry(to)) {
      fail(importer, e.to, 'a core layer loads the entry file');
      continue;
    }
    const fi = layerOf(fromName);
    const ti = layerOf(toName);
    if (fi === -1) fail(importer, e.to, `core "${fromName}" is not in CORE_LAYERS`);
    else if (ti === -1) fail(importer, e.to, `core "${toName}" is not in CORE_LAYERS`);
    else if (ti > fi) fail(importer, e.to, `core/${fromName} loads the higher layer core/${toName}`);
  }
  return [...new Set(problems)];
};
