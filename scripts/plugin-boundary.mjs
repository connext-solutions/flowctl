/**
 * Plugin boundary scan used by `check-arch.mjs` (ADR 0023): no code, manifest or build wiring outside a
 * `packages/plugin-*` package names a plugin.
 *
 * @remarks Scanned: every tracked file of every non-plugin package, and every other tracked file outside
 * `packages/` (see `isRootWiring`: hooks, workflows, dotfiles, build scripts, `docs/` code and config, any
 * extension) except the `ROOT_ALLOWED` and gate files. Prose `.md`/`.txt`/`.rst` is not scanned. The scan is a tripwire, not
 * a proof (see Limits).
 *
 * Source files (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`, `.d.ts` included) go through the TypeScript
 * parser and these are tested: every string and template fragment, every regular-expression literal, and
 * every quoted string inside a comment (so `/// <reference types="...">` and the JSDoc forms
 * `@import {p} from "..."` and `@type {import("...")}` are seen; a comment that names a plugin in prose, without quotes,
 * is not an import and passes). Multi-line `import()`, `require`, `createRequire(...)()`,
 * `import x = require()`, `vi.mock`/`vi.importActual`, re-exports and several imports on one line are
 * all seen. JSON and JSONC files are parsed first and every key and value is tested after decoding
 * (`\u` escapes cannot hide a name); `\u`/`\x` escapes are also decoded in the raw text of every other
 * file. Percent-encoded names (`plugin%2Dexample`) are decoded before the test. Every other text file
 * (yaml, html, vue, extensionless scripts) is tested as whole-text tokens split on every character outside
 * `[\w@./\\%-]`, so shell pipes and `&` do not hide a name. The caller decides what is binary (a
 * known-extension allowlist); an unknown binary or unreadable file is a failure, not a skip.
 *
 * The root `tsconfig.json` is scanned with its `references` removed: that is the only place the root may
 * name a plugin (`paths` mappings, `include`, anything else fail).
 *
 * A name counts as a plugin when, case-folded, it contains a known plugin name (a
 * `packages/plugin-*` directory name, its `package.json` name, or `flowctl-<dir>`), is a workspace plugin
 * scope name, names a `packages/plugin-*` path, or is a relative path that resolves into one.
 * A literal that contains `flowctl-plugin-`, or that ends in `plugin-` right after a path separator or at
 * its start, is a plugin name still being built (`` `@scope/flowctl-plugin-${n}` ``, `'../plugin-' + n`)
 * and fails. `@vitejs/plugin-react` is not a workspace plugin.
 *
 * @remarks Limits, stated plainly: a static scan cannot prove that a program never builds a module name at
 * run time. A name assembled from pieces that each carry no plugin marker
 * (`['plugin', 'exam', 'ple'].join('-')`, `'@scope/flowctl-' + variable`) is NOT caught here; the scan
 * catches a literal that itself contains a plugin name or a name prefix (`flowctl-plugin-`, `/plugin-`
 * at the end of a literal). In core, `check-arch` also fails every `import()`/`require()` whose
 * argument is not a string literal. The second backstop is a check over the built output's loaded
 * modules (task T0.16), which is the real enforcement: this scan is a tripwire for mistakes and cheap
 * tricks, and the load check is to be extended to the layer rules as well. ASCII tab, LF and CR are
 * stripped from every name before the test, because Node's URL parser strips them from specifiers.
 */
import { posix } from 'node:path';
import ts from 'typescript';
import { SOURCE, commentRanges, safeDecode } from './module-specs.mjs';

const SCOPED = /@acme\/flowctl-plugin-[\w-]+/i;
const PLUGIN_PATH = /(?:^|[/\\])packages[/\\]plugin-/i;
/**
 * Root files that must reference the plugin: the lockfile to build it, and the export's rewrite table to leave it
 * out (ADR 0029). The export rewrites the lockfile and does not copy the table.
 */
const ROOT_ALLOWED = new Set(['bun.lock', 'scripts/export/rewrites.mjs']);
const PLUGIN_PREFIX = /flowctl-plugin-/i;
const NAME_TAIL = /(?:^|[/\\])plugin-$/i;
/** Gate files that must name the plugin to detect it, including the T0.16 bundle load check and its tests. */
const GATE_FILES = new Set([
  'scripts/check-arch.mjs',
  'scripts/check-arch.helpers.mjs',
  'scripts/check-arch.boundary-source.test.mjs',
  'scripts/check-arch.wiring.test.mjs',
  'scripts/check-arch.layers.test.mjs',
  'scripts/check-arch.imports.test.mjs',
  'scripts/check-arch.calls.test.mjs',
  'scripts/check-arch.rounds.test.mjs',
  'scripts/check-arch.late.test.mjs',
  'scripts/check-arch.env.test.mjs',
  'scripts/env-reads.mjs',
  'scripts/env-input-baseline.mjs',
  'scripts/plugin-boundary.mjs',
  'scripts/module-specs.mjs',
  'scripts/check-bundle-plugins.mjs',
  'scripts/bundle-load-analyse.mjs',
  'scripts/check-bundle-plugins.test.mjs',
  'scripts/check-bundle-plugins.more.test.mjs',
  'scripts/check-bundle-plugins.descendants.test.mjs',
  'scripts/check-bundle-plugins.helpers.mjs',
]);

/** Whether `file` is a candidate for the scan: any file of a package that is not itself a plugin. */
export const inPluginFreePackage = (file) => {
  const m = /^packages\/([^/]+)\//.exec(file);
  return m !== null && !(m[1] ?? '').startsWith('plugin-');
};

/**
 * Whether `file` is scanned as wiring: every tracked file outside `packages/` (package files are covered
 * by `inPluginFreePackage`, plugins are exempt) except prose (`.md`, `.txt`, `.rst`; binary extensions are
 * skipped by the caller) and the `ROOT_ALLOWED` and gate files. A `docs/` file with a code or config
 * extension is scanned like any other.
 */
export const isRootWiring = (file) => {
  if (ROOT_ALLOWED.has(file) || GATE_FILES.has(file)) return false;
  if (file.startsWith('packages/')) return false;
  return !/\.(?:md|txt|rst)$/i.test(file);
};

/**
 * Joins backslash line continuations (yaml, toml, json5 strings) and decodes the four-digit, braced,
 * eight-digit (toml) unicode escapes and `\x` escapes so they cannot hide a name.
 */
const unescapeText = (text) =>
  text
    .replace(/\\\r?\n[ \t]*/g, '')
    .replace(/\\U([0-9a-f]{8})/g, (m, a) => fromHex(a, m))
    .replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (m, a, b, c) => fromHex(a ?? b ?? c, m));
const fromHex = (hex, orig) => {
  try {
    return String.fromCodePoint(Number.parseInt(hex, 16));
  } catch {
    return orig;
  }
};

/** Builds the test for one file; `known` holds plugin names: directories, package names, `flowctl-<dir>`. */
const namesPlugin = (file, known) => {
  const names = new Set(known.map((k) => k.toLowerCase()));
  const test = (spec) => {
    if (SCOPED.test(spec) || PLUGIN_PATH.test(spec) || PLUGIN_PREFIX.test(spec) || NAME_TAIL.test(spec)) return true;
    for (const n of names) if (spec.includes(n)) return true;
    const parts = spec.split(/[/\\]/);
    if (parts.some((p) => names.has(p))) return true;
    if (spec.startsWith('.')) {
      const target = posix.join(posix.dirname(file), spec.replaceAll('\\', '/'));
      return target.startsWith('packages/plugin-');
    }
    return false;
  };
  return (raw) => {
    const lower = unescapeText(raw).replace(/[\t\n\r]/g, '').toLowerCase();
    return test(lower) || test(safeDecode(lower));
  };
};

const literals = (sf) => {
  const out = [];
  const visit = (node) => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node) ||
      ts.isRegularExpressionLiteral(node)
    )
      out.push({ text: node.text, pos: node.getStart(sf) });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
};

const MAX_QUOTED = 1024;
/**
 * Quoted strings of a comment body, found with a bounded linear scan: each opening quote looks ahead at most
 * `MAX_QUOTED` characters and never past a line end, and a backslash never consumes a line end. A quote that
 * does not close on its line, or not within the bound, yields the raw rest of its line instead, so the
 * caller's plain name test still sees a long or broken specifier (at most one such span per line).
 */
const quotedStrings = (body) => {
  const out = [];
  let spanEnd = -1;
  for (let i = 0; i < body.length; i++) {
    const q = body[i];
    if (q !== '"' && q !== "'" && q !== '`') continue;
    let closed = false;
    for (let j = i + 1; j < body.length && j - i <= MAX_QUOTED; j++) {
      const c = body[j];
      if (c === '\n') break;
      if (c === '\\') {
        if (body[j + 1] !== '\n') j++;
      } else if (c === q) {
        out.push({ text: body.slice(i + 1, j), index: i });
        i = j;
        closed = true;
        break;
      }
    }
    if (!closed && i >= spanEnd) {
      const eol = body.indexOf('\n', i + 1);
      spanEnd = eol === -1 ? body.length : eol;
      out.push({ text: body.slice(i + 1, spanEnd), index: i });
    }
  }
  return out;
};
/** Quoted strings inside comments: where `/// <reference>`, `@import` and `import("...")` hide a specifier. */
const commentStrings = (sf, text) =>
  commentRanges(sf, text).flatMap((r) =>
    quotedStrings(text.slice(r.pos, r.end)).map((m) => ({ text: m.text, pos: r.pos + m.index })),
  );

/** Every key and string value of parsed JSON, decoded; `skip` names a top-level key to leave out. */
const jsonStrings = (file, text, skip) => {
  const { config, error } = ts.parseConfigFileTextToJson(file, text);
  if (error !== undefined || config === null || typeof config !== 'object') return undefined;
  const out = [];
  const walk = (v, top) => {
    if (typeof v === 'string') out.push(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, false));
    else if (v !== null && typeof v === 'object')
      for (const [k, x] of Object.entries(v)) {
        if (top && k === skip) continue;
        out.push(k);
        walk(x, false);
      }
  };
  walk(config, true);
  return out;
};

const rawHit = (text, names) =>
  unescapeText(text)
    .split(/[^\w@./\\%-]+/)
    .find((tok) => tok.length > 0 && names(tok));

/**
 * @param file repo-relative path
 * @param text file contents (text; callers skip binary files)
 * @param known plugin names present in the repo, plus the defaults
 * @returns `{ line, spec }` per violation; `line` is 0 for whole-file matches
 */
export const scanPluginBoundary = (file, text, known) => {
  const names = namesPlugin(file, known);
  if (SOURCE.test(file)) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    return [...literals(sf), ...commentStrings(sf, text)]
      .filter((l) => names(l.text))
      .map((l) => ({
        line: sf.getLineAndCharacterOfPosition(l.pos).line + 1,
        spec: l.text,
      }));
  }
  const rootConfig = file === 'tsconfig.json';
  const strings = /\.jsonc?$/i.test(file) ? jsonStrings(file, text, rootConfig ? 'references' : undefined) : undefined;
  const hit = strings === undefined ? rawHit(text, names) : strings.find((s) => names(s));
  if (hit === undefined && strings !== undefined && !rootConfig) {
    const raw = rawHit(text, names);
    return raw === undefined ? [] : [{ line: 0, spec: raw }];
  }
  return hit === undefined ? [] : [{ line: 0, spec: hit }];
};
