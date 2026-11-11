/**
 * Architecture gate run by `bun run check`: turns the written rules (AGENTS.md, .claude/rules) into
 * failures instead of reminders.
 *
 * @remarks Checks tracked and untracked files that git does not ignore:
 * - files in `packages/*\/src` and `packages/*\/test` stay ≤ 300 lines;
 * - packages import each other by package name only, in the allowed direction, and `src/` never
 *   imports fixture-app;
 * - inside core, a folder imports only lower layers, only through their `index.js`, and never the
 *   entry files (`replay.ts`, `save.ts`, `login.ts`, `index.ts`);
 * - no full-line `//` comments in `src/` except `oxlint-disable` and `dup-ok` directives;
 * - no file mentions the internal working-docs folder;
 * - no code, manifest or build wiring outside a `plugin-*` package names a plugin (ADR 0023, see
 *   `plugin-boundary.mjs`); tracked symlinks, gitlinks and unreadable files are failures;
 * - `saveAsGenerator` (tripwire, normalised text) appears in no tracked source file except `core/src/derive/`,
 *   `core/src/save.ts` and `core/test/derive/`, and not in `derive/index.ts`;
 * - a tracked path with a control character or line break fails; own-package, `#`, absolute and `file:`
 *   specifiers fail; src never imports test code; top-level core files obey their layer too;
 * - import rules apply to every source file of every package (`bin/`, `lib/`, config files too, not only
 *   `src/` and `test/`); a core file outside `src/` and `test/` may not import the entry file; a bare `..` or
 *   `../../src` that resolves to `packages/core/src` counts as the entry file; percent-encoded specifiers
 *   are decoded; `import()`/`require()` with a non-literal argument in core (outside tests) fails because it
 *   cannot be checked;
 * - every package directory is known to `PACKAGE_DEPS`;
 * - fixed waits (`waitForTimeout`, timer sleeps) only in `SLEEP_ALLOWED` files (`.claude/rules/performance.md`);
 * - core never prints or exits (`console.*`, `process.exit`, `process.stdout`) (`.claude/rules/reliability.md`);
 * - no new env-input path in `packages/*\/src` (T0.13): a new read of the process environment or `env` input key
 *   fails unless listed in `env-input-baseline.mjs` (ADR 0024 section 7; flow inputs are also checked against the
 *   trust store allowlist since T1.14); a baseline entry whose
 *   code is gone fails too (checked when the repo carries the baseline file). What is and is not detected is in
 *   the header of `env-reads.mjs`.
 * A new package must be added to `PACKAGE_DEPS` and `PACKAGE_NAMES`.
 * This gate is a static tripwire for mistakes and cheap tricks, not a proof: a program can still build a
 * module name or path at run time. The real enforcement is the T0.16 load check over the built output,
 * (`check-bundle-plugins.mjs`), which also enforces the layer rules on what a core layer actually loads;
 * the layer list lives in `core-layers.mjs`, shared by both.
 * Ported code listed in `ALLOW_COMMENTS` keeps its upstream comments.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { posix } from 'node:path';
import { CORE_LAYERS, isEntry, layerName, layerOf } from './core-layers.mjs';
import { SOURCE, safeDecode, scanModule } from './module-specs.mjs';
import { inlineCommentLines } from './inline-comments.mjs';
import { ENV_BASELINE } from './env-input-baseline.mjs';
import { compareEnvBaseline, scanEnvReads } from './env-reads.mjs';
import { inPluginFreePackage, isRootWiring, scanPluginBoundary } from './plugin-boundary.mjs';

const MAX_LINES = 300;
/** Scopes of workspace packages: the public engine (`@flowctl/`, ADR 0029) and the private plugins. */
const SCOPES = ['@flowctl/', '@acme/'];
/** Package directory → package directories its `src/` may import. */
const PACKAGE_DEPS = {
  core: [],
  cli: ['core'],
  mcp: ['core'],
  'fixture-app': [],
  'plugin-example': ['core'],
};
const PACKAGE_NAMES = {
  '@flowctl/core': 'core',
  '@flowctl/cli': 'cli',
  '@flowctl/mcp': 'mcp',
  '@flowctl/fixture-app': 'fixture-app',
  '@acme/flowctl-plugin-example': 'plugin-example',
};
/** Plugin directories always treated as plugins, even before they exist in the checkout (ADR 0023). */
const DEFAULT_PLUGINS = ['plugin-example'];
/** Extensions of files that are binary by nature; any other file with NUL bytes is a failure. */
const BINARY_EXT = /\.(?:png|jpe?g|gif|ico|webp|pdf|zip|gz|tgz|woff2?|ttf|otf|xlsx|docx|mp4|wasm|lockb|sqlite|db)$/i;
/** Ported upstream code, and HTML/JS served from template strings (its `//` are not TypeScript comments). */
const ALLOW_COMMENTS = new Set([
  'packages/core/src/browser/snapshot-script.ts',
  'packages/fixture-app/src/pages.ts',
]);
/** Files whose fixed waits are deliberate; each entry says why. */
const SLEEP_ALLOWED = new Map([
  ['packages/core/src/explore/act.ts', 'the WAIT operation'],
  ['packages/core/src/browser/executor.ts', 'the `wait` step and the fill settle'],
  ['packages/core/src/browser/secret-fill.ts', 'the fill settle and the CDP insert timeout'],
  ['packages/core/src/run/deadline.ts', 'the wall-clock budget timer (ADR 0024 section 6)'],
  ['packages/core/src/run/ledger/cleanup.ts', 'the cleanup retry and verify delays, 1 s and 2 s within 120 s (ADR 0024 amendment 2026-11-12 section 7)'],
  ['packages/core/src/run/ledger/run-ledger.ts', 'the bound on the wait for writes in flight when a run ends (ADR 0024 section 5)'],
  ['packages/core/src/run/video.ts', 'demo-video pacing so a viewer can read each step (ADR 0032)'],
  ['packages/core/src/browser/snapshot.ts', 'bounded poll for an SPA first control'],
  ['packages/core/src/run/verifier.ts', 'bounded assertion polling'],
  ['packages/core/src/run/evidence.ts', 'bounded wait for response bodies before an escalation writes the logs'],
  ['packages/core/src/trust/hookrun/spawn.ts', 'hook timeout timer and pipe drain'],
  ['packages/core/src/system1/client.ts', 'retry backoff'],
  ['packages/fixture-app/src/server.ts', 'simulated slow API'],
  ['packages/fixture-app/src/items.ts', 'a create answered late, for the run ledger tests'],
  ['packages/mcp/src/runs.ts', 'bounded wait of one tool call (ADR 0012)'],
]);
/**
 * Tripwire for the generator-only save function of ADR 0020 b. The text is normalised first (escapes
 * decoded, quotes, plus signs and whitespace removed) so concatenation, `\\u` escapes and bracket access
 * are caught heuristically. It is a tripwire, not a proof: the real control is that the function is not
 * exported from the package and is reached only through a capability created in derive.
 */
const GENERATOR_SAVE = /saveasgenerator/i;
const GENERATOR_SAVE_OK =
  /^(?:packages\/core\/(?:src\/derive\/|src\/save\.ts$|test\/derive\/)|scripts\/(?:check-arch|check-arch\.helpers|check-arch\.(?:boundary-source|wiring|layers|imports|calls|rounds|late)\.test|plugin-boundary|module-specs)\.mjs$)/;
const squash = (text) =>
  text
    .replace(/\\u\{([0-9a-f]+)\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (_, a, b, c) =>
      String.fromCodePoint(Number.parseInt(a ?? b ?? c, 16)),
    )
    .replace(/\$\{[\s'"`]*\}/g, '')
    .replace(/['"`+\s]/g, '');
const SLEEP = /\bwaitForTimeout\(|\bsetTimeout\b/;
const CORE_OUTPUT = /\bconsole\.\w+\(|\bprocess\.(exit|stdout|stderr)\b/;
const INTERNAL_DOCS = ['docs', 'super' + 'powers'].join('/');
const LINE_BREAK = new RegExp(['\\r\\n', '[\\r\\n\\u2028\\u2029]'].join('|'));
// oxlint-disable-next-line no-control-regex -- the gate matches control characters on purpose
const CONTROL = new RegExp('[\\u0000-\\u001f\\u007f\\u2028\\u2029]');

const git = (args) =>
  execFileSync('git', ['-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 1 << 28 });
const problems = [];
const report = (file, line, msg) => problems.push(`${JSON.stringify(file).slice(1, -1)}${line ? `:${line}` : ''}  ${msg}`);

/** Runs a per-file scan; a crash (deep nesting, stack overflow) becomes a violation that names the file. */
const attempt = (file, fn, fallback) => {
  try {
    return fn();
  } catch (e) {
    report(file, 0, `cannot be scanned (${e?.name ?? 'error'}: ${e?.message ?? e})`);
    return fallback;
  }
};

let top;
try {
  top = git(['rev-parse', '--show-toplevel']).trim();
  process.chdir(top);
} catch {
  console.error('check-arch: not inside a git repository');
  process.exit(1);
}
const split0 = (out) => out.split('\0').filter(Boolean);
const files = split0(git(['ls-files', '-z', '-co', '--exclude-standard']));
const deleted = new Set(split0(git(['ls-files', '-z', '-d'])));
for (const entry of split0(git(['ls-files', '-z', '-s'])))
  if (entry.startsWith('160000 ')) report(entry.split('\t').slice(1).join('\t'), 0, 'gitlink (submodule); its files are invisible to the gates, vendor the code or remove it');
if (files.length === 0) {
  console.error('check-arch: no files found; refusing to pass on an empty list');
  process.exit(1);
}

const pluginDirs = [
  ...new Set([
    ...DEFAULT_PLUGINS,
    ...files.flatMap((f) => /^packages\/(plugin-[^/]+)\//.exec(f)?.[1] ?? []),
  ]),
];
/** Every plugin directory, its `flowctl-` form and the `name` in its package.json. */
const KNOWN_PLUGINS = [
  ...new Set(
    pluginDirs.flatMap((d) => {
      let name = [];
      try {
        const pj = `packages/${d}/package.json`;
        const st = lstatSync(pj);
        if (!st.isFile()) {
          report(pj, 0, 'plugin package.json is a symbolic link or not a regular file; copy it as a plain file');
          return [d, `flowctl-${d}`];
        }
        const parsed = JSON.parse(readFileSync(pj, 'utf8').replace(/^\uFEFF/, ''));
        if (typeof parsed.name === 'string') name = [parsed.name];
      } catch (e) {
        if (e?.code !== 'ENOENT')
          report(`packages/${d}/package.json`, 0, 'plugin package.json cannot be read or parsed; its name would be unknown to the boundary scan');
      }
      return [d, `flowctl-${d}`, ...name];
    }),
  ),
];

/** Counts the parity of zero bytes: UTF-16 text without a BOM has a zero in every other byte. */
const utf16Guess = (buf) => {
  const n = Math.min(buf.length, 4096);
  if (n < 4) return undefined;
  let even = 0;
  let odd = 0;
  for (let i = 0; i < n; i++) {
    if (buf[i] !== 0) continue;
    if (i % 2 === 0) even++;
    else odd++;
  }
  if (odd / (n / 2) > 0.3 && even === 0) return 'le';
  if (even / (n / 2) > 0.3 && odd === 0) return 'be';
  return undefined;
};

/** Decodes a file; source files are never exempt, other binaries only by a known extension. */
const decode = (file, buf) => {
  if (BINARY_EXT.test(file)) return { skip: true };
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le') };
  if (buf[0] === 0xfe && buf[1] === 0xff)
    return { text: Buffer.from(buf.subarray(2)).swap16().toString('utf16le') };
  const guess = utf16Guess(buf);
  if (guess === 'le') return { text: buf.toString('utf16le') };
  if (guess === 'be') return { text: Buffer.from(buf).swap16().toString('utf16le') };
  const text = buf.toString('utf8');
  if (SOURCE.test(file) || !buf.subarray(0, 8192).includes(0)) return { text };
  return { error: 'unknown binary file (NUL bytes); add its extension to BINARY_EXT or remove it' };
};

const known = (map, key) => Object.hasOwn(map, key);
const envFound = [];

for (const file of files) {
  if (CONTROL.test(file)) {
    report(file, 0, 'path contains a control character or line break; rename it');
    continue;
  }
  let text;
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      report(file, 0, 'symbolic link; links hide imports from the gates, copy the file instead');
      continue;
    }
    if (!st.isFile()) {
      report(file, 0, 'cannot read (not a regular file); gitlinks, directories, FIFOs and devices are failures, not skips');
      continue;
    }
    const d = decode(file, readFileSync(file));
    if (d.skip) continue;
    if (d.error) {
      report(file, 0, d.error);
      continue;
    }
    text = d.text;
  } catch (e) {
    if (!(e?.code === 'ENOENT' && deleted.has(file)))
      report(file, 0, `cannot read (${e?.code ?? 'error'}); gitlinks, odd names and unreadable files are failures, not skips`);
    continue;
  }
  if (file !== 'scripts/check-arch.mjs' && text.includes(INTERNAL_DOCS))
    report(file, 0, `mentions ${INTERNAL_DOCS} (internal, never referenced from the repo)`);

  if (inPluginFreePackage(file) || isRootWiring(file))
    for (const v of attempt(file, () => scanPluginBoundary(file, text, KNOWN_PLUGINS), []))
      report(file, v.line, `may not import a plugin (${v.spec}); plugins depend on core, never the reverse (ADR 0023)`);

  if (SOURCE.test(file) && !GENERATOR_SAVE_OK.test(file) && GENERATOR_SAVE.test(squash(text)))
    report(file, 0, 'saveAsGenerator is internal to derive and save (ADR 0020 b); the public save always records human');
  if (file === 'packages/core/src/derive/index.ts' && GENERATOR_SAVE.test(squash(text)))
    report(file, 0, 'derive/index must not list saveAsGenerator; it is never exported from the package (ADR 0020 b)');

  const info = SOURCE.test(file) ? attempt(file, () => scanModule(file, text), undefined) : undefined;
  for (const e of info?.errors ?? [])
    report(file, e.line, `syntax error (${e.message}); a file that cannot be parsed cannot be checked`);

  const m = /^packages\/([^/]+)\/(?:(src|test)\/)?[\s\S]+\.(?:[cm]?[jt]sx?)$/i.exec(file);
  if (m === null) continue;
  const [, pkg] = m;
  /** `other` is any source file outside src/ and test/ (bin/, lib/, config files): imports checked, text rules not. */
  const kind = (m[2] ?? 'other').toLowerCase();
  if (!known(PACKAGE_DEPS, pkg))
    report(file, 0, `unknown package ${pkg}; add it to PACKAGE_DEPS and PACKAGE_NAMES`);
  const lines = text.split(LINE_BREAK);
  const count = lines.length - (lines[lines.length - 1] === '' ? 1 : 0);
  if (kind !== 'other' && count > MAX_LINES) report(file, 0, `${count} lines (max ${MAX_LINES}); split it`);

  if (kind !== 'other')
    lines.forEach((line, i) => {
      const n = i + 1;
      if (kind === 'src' && SLEEP.test(line) && !SLEEP_ALLOWED.has(file) && !ALLOW_COMMENTS.has(file))
        report(file, n, 'fixed wait; wait on a condition, or add the file to SLEEP_ALLOWED with a reason');
      if (pkg === 'core' && kind === 'src' && CORE_OUTPUT.test(line))
        report(file, n, 'core must not print or exit; return a result or throw a typed error');
    });

  if (kind === 'src' && !ALLOW_COMMENTS.has(file) && SOURCE.test(file))
    for (const n of attempt(file, () => inlineCommentLines(file, text), []))
      report(file, n, 'inline comment; move the context into JSDoc');

  const fromParts = /^packages\/core\/src\/([\s\S]+)$/i.exec(file)?.[1]?.split('/');
  const inCoreSrc = pkg === 'core' && kind === 'src' && fromParts !== undefined;
  const fromName = inCoreSrc ? layerName(fromParts) : '';
  const fromEntry = inCoreSrc && isEntry(fromParts);
  if (inCoreSrc && !fromEntry && layerOf(fromName) === -1)
    report(file, 0, `core ${fromParts.length > 1 ? 'folder' : 'top-level file'} "${fromName}" is not in CORE_LAYERS; give it a layer`);

  if (kind === 'src' && SOURCE.test(file))
    for (const v of attempt(file, () => scanEnvReads(file, text), []))
      envFound.push({ file, ...v });

  const guarded = ['core', 'cli', 'fixture-app', 'mcp'].includes(pkg) && kind !== 'test';
  const RISK = {
    dynamic: [guarded, 'import()/require() with a non-literal specifier; a non-literal specifier cannot be checked, use a string literal'],
    enumerate: [guarded, 'enumerating the packages directory (import.meta.glob, readdir of packages); name the packages you use'],
    indirect: [guarded, 'indirect module loader cannot be checked; call require()/createRequire(...)() directly with a string literal'],
    eval: [guarded, 'eval/Function builds code at run time and cannot be checked'],
  };
  for (const { kind: k, line: n } of info?.risks ?? []) if (RISK[k]?.[0]) report(file, n, RISK[k][1]);
  for (const { spec: written, raw, indirect, line: n } of info?.specs ?? []) {
    if (indirect && kind === 'test') continue;
    if (CONTROL.test(written))
      report(file, n, `specifier ${JSON.stringify(written).slice(1, -1)} contains a control character; Node strips tab, LF and CR from specifiers, so the name cannot be trusted`);
    const decoded = safeDecode(written.replace(/[\t\n\r]/g, ''));
    const spec = decoded.startsWith('.') ? decoded.replace(/[?#][\s\S]*$/, '') : decoded;
    if (spec.startsWith('.') && (spec.includes('\\') || raw.includes('\\'))) {
      report(file, n, `relative import ${JSON.stringify(spec).slice(1, -1)} contains a backslash (or a backslash escape); Node reads \\ as a slash, so the layer checks cannot follow it`);
      continue;
    }
    if (spec.startsWith('#')) {
      report(file, n, `package import ${spec}; "#imports" hide the dependency graph, use a relative import`);
      continue;
    }
    if (spec.startsWith('/') || /^file:/i.test(spec)) {
      report(file, n, `absolute import ${spec}; import the package name or a relative path`);
      continue;
    }
    const scope = SCOPES.find((s) => spec.toLowerCase().startsWith(s));
    if (scope !== undefined) {
      const [first, ...deep] = spec.slice(scope.length).toLowerCase().split('/');
      const name = `${scope}${first ?? ''}`;
      const target = known(PACKAGE_NAMES, name) ? PACKAGE_NAMES[name] : undefined;
      if (deep.length > 0) report(file, n, `deep import ${spec}; import the package name`);
      if (target === pkg) report(file, n, `self-reference ${spec}; a package never imports itself by name (use a relative import)`);
      else if (target === 'fixture-app' && kind !== 'test') report(file, n, 'src imports fixture-app; only tests may');
      else if (kind !== 'test' && target !== undefined && !(PACKAGE_DEPS[pkg] ?? []).includes(target))
        report(file, n, `${pkg} may not depend on ${target}`);
      continue;
    }
    if (!spec.startsWith('.')) continue;
    const target = posix.join(posix.dirname(file), spec);
    const dir = `${target}/`.toLowerCase();
    if (!dir.startsWith(`packages/${pkg}/`.toLowerCase())) {
      report(file, n, `relative import ${spec} leaves the package; import the package name`);
      continue;
    }
    if (kind !== 'test' && dir.startsWith(`packages/${pkg}/test/`.toLowerCase())) {
      report(file, n, `${kind} imports test code (${spec})`);
      continue;
    }
    if (pkg !== 'core' || kind === 'test') continue;
    if (inCoreSrc && !dir.startsWith('packages/core/src/')) {
      report(file, n, `core src import ${spec} resolves outside packages/core/src; layers and the entry-file ban cannot follow it`);
      continue;
    }
    const bare = target.replace(/\/+$/, '');
    const inSrc = bare.toLowerCase() === 'packages/core/src' ? '' : /^packages\/core\/src\/([\s\S]+)$/i.exec(target)?.[1];
    if (inSrc === undefined) continue;
    const toParts = inSrc.split('/');
    if (inSrc === '' || isEntry(toParts)) {
      if (!fromEntry) report(file, n, `core${inCoreSrc ? `/${fromName}` : ` file ${file}`} may not import the entry file ${spec}`);
      continue;
    }
    if (!inCoreSrc) {
      const rest0 = toParts.slice(1).join('/');
      if (toParts.length > 1 && rest0 !== 'index.js') report(file, n, `import core/${layerName(toParts)} through its index.js, not ${rest0}`);
      continue;
    }
    const toName = layerName(toParts);
    if (toName.toLowerCase() === fromName.toLowerCase() || fromEntry) continue;
    const fi = layerOf(fromName);
    const ti = layerOf(toName);
    if (ti === -1) report(file, n, `core "${toName}" is not in CORE_LAYERS; give it a layer`);
    if (ti === -1 || fi === -1) continue;
    if (ti >= fi) report(file, n, `core/${fromName} may not import core/${toName} (layers: ${CORE_LAYERS.join(' ← ')})`);
    const rest = toParts.slice(1).join('/');
    if (toParts.length > 1 && rest !== 'index.js') report(file, n, `import core/${toName} through its index.js, not ${rest}`);
  }
}

const carriesBaseline = files.includes('scripts/env-input-baseline.mjs');
for (const p of compareEnvBaseline(envFound, ENV_BASELINE, carriesBaseline)) report(p.file, p.line, p.msg);

if (problems.length > 0) {
  console.error(`check-arch: ${problems.length} problem(s)\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('check-arch: ok');
