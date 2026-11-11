/**
 * Runtime load check (task T0.16), run after the build: a second, runtime look at the plugin boundary
 * (ADR 0023) and at core layering. `check-arch.mjs` is the static tripwire; this script looks at what Node
 * actually loads. Neither is a defence against a hostile change: code under test runs in the same
 * process as the hook (see Limits).
 *
 * @remarks For each non-plugin package under `packages/` (except the `SOURCE_ONLY` allowlist) it runs
 * child Node processes under `bundle-load-hook.cjs` (synchronous `module.registerHooks`) and
 * `bundle-load-driver.mjs`, which imports every entry point through Node's own resolution: `"."` and each
 * literal `exports` subpath (only targets under a `types` condition and `package.json` are skipped; a
 * `.d.ts` target elsewhere is a problem, as TypeScript source), by `import()`, by `require()` when an
 * exports object has a `require` condition, and once more per distinct set of conditions on a root-to-leaf
 * path (all conditions of a path together). Every `bin` target runs in its own traced process with
 * `--help` and a scrubbed environment (`PATH` and the hook only); it must exit 0 (`bin.ts` maps a
 * rejected `main` to 2, which would hide a failed load). A bin still executes the pull request's code,
 * and may behave differently without `--help`.
 * The parent fails, naming importer and importee, when:
 * - any loaded module lies under `packages/plugin-*` or in a `node_modules/[@scope/]*flowctl-plugin-*`;
 * - a loaded file lies outside `packages/*\/dist` and the root `node_modules` (a plugin copied to a temp
 *   folder), is in `node_modules` but of a package no workspace `package.json` or the lockfile declares, or
 *   is a `dist` file without a source file (an accident check: an empty `src` stub defeats it);
 * - a core `dist` module loads a higher layer or an entry file, or is in a folder missing from
 *   `CORE_LAYERS` (the list `check-arch.mjs` uses, from `core-layers.mjs`); a same-layer import is allowed;
 * - code under test registers module hooks (`register`, `registerHooks`);
 * - the run is malformed: a bad or unterminated trace line, a trace flood, no `done` marker (an entry that
 *   never settles or exits early), an empty trace, a timeout, a descendant still alive at the timeout, a
 *   missing build, a missing `core` or `cli`, `exports` without `name`, an `exports` pattern with `*`
 *   (add an intentional one to `PATTERN_ALLOWED` as `<dir><key>`; it is then not loaded).
 * Events travel on a pipe (fd 3) and a FIFO the parent owns; every traced process holds a FIFO write end,
 * and the parent reads until none is left (deterministic drain, bounded by the timeout). The child runs in
 * its own process group, which is killed at the end; SIGINT, SIGTERM and SIGHUP clean up and exit 130, 143
 * and 129. At most 4 traced runs are in flight. A child killed by a signal is reported as
 * `child killed by signal X`. Exit 0 on success, 1 on any problem. Usage: `node scripts/check-bundle-plugins.mjs [--root <repo>]`.
 * `node_modules` names come from `package.json` files and `bun.lock` (parsed as JSON after dropping
 * trailing commas, keys and the first tuple element, so aliases count; a line regex if that fails).
 * `BUNDLE_CHECK_TIMEOUT_MS` (integer, 1 to 600000, default 60000) sets the per-run timeout (tests use it).
 *
 * Closed at run time (each has a test): named imports of `_load`, `register`, `registerHooks`;
 * `process.getBuiltinModule('module')`; `module.constructor._load`; `data:` specifiers;
 * `new Worker(code, { eval: true })`, also with `env: {}` or `execArgv: []`; `exec`, `execSync`,
 * `execFile`, `execFileSync` of a script; `node:vm` code that reaches the loader; a plugin copied
 * elsewhere; an orphan that loads a plugin after the entry exits.
 *
 * NOT observed, stated plainly. This is not a defence against a hostile pull request:
 * - hostile code in the same process as the hook. It can forge trace lines. It can drain lines already
 *   written to the FIFO: a traced descendant can open the FIFO read-only and read its own lines before the
 *   parent does (a race, observed in 5 of 6 tries). Lines on fd 3 cannot be erased, but fd 3 can be
 *   duplicated through `/dev/fd/3`, closed and swapped for `/dev/null`, after which a forged `done` passes.
 *   It can replace the FIFO by one it reads itself or call `process.exit(0)` after forging `done`;
 * - a Worker built from the original class (`Object.getPrototypeOf(Worker)`, or a fresh
 *   `createRequire(...)('worker_threads')`; the hook only raises the bar);
 * - an untraced child needs no explicit `env`: `NODE_OPTIONS= node -e ...` and `env -u NODE_OPTIONS node`
 *   evade the hook, as do `fork`/`spawn` with an explicit `env`, `process.execve`, and non-Node programs.
 *   The listed `exec`, `execSync`, `execFile` and `execFileSync` bypasses are closed only while the child
 *   inherits `NODE_OPTIONS`; a child with `FLOWCTL_TRACE_SEEN` deleted that has its own fd 3 is not seen;
 * - a detached orphan: it fails the run only while a traced process is alive (the quiet window is 250 ms);
 *   a non-Node detached orphan holds no FIFO end and is invisible; one that closes its FIFO descriptor too;
 * - a load scheduled with an unref'd timer or Worker after `done`, if the process exits first;
 * - plugin text read with `fs` and run through `vm`, `Function`, `eval`, `Module.prototype._compile` or
 *   `Module._extensions`, and native addons: no module load happens;
 * - modules the entries never load: type-only imports erased by `tsc`, orphan `dist` files, code behind a
 *   function call (the check imports entries, it does not call the API); the layer rule covers only the
 *   edges reached from the entries;
 * - `import.meta.resolve` alone is reported as a load (over-detection);
 * - core importing `cli` or another package: left to `PACKAGE_DEPS` in `check-arch.mjs`;
 * - the `fixture-app` source (test-only, not built; allowlisted in `SOURCE_ONLY`);
 * - plugin text placed inside a declared `node_modules` package;
 * - local runs: the entries run with the caller's environment (a bin gets a scrubbed one), so a local
 *   pre-push runs the pull request's code with the developer's secrets; CI `verify` has none;
 * - Windows and any system without `mkfifo`: only POSIX is supported.
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, constants, existsSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { analyse, canonical, norm } from './bundle-load-analyse.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, 'bundle-load-hook.cjs');
const DRIVER = join(HERE, 'bundle-load-driver.mjs');
const MAX_TRACE = 32 * 1024 * 1024;
/** How long no traced process may exist (no FIFO writer, empty process group) before a run is settled. */
const SETTLE_MS = 250;
/** Packages that must be built and checked; a missing one fails instead of shrinking the check. */
const REQUIRED = ['core', 'cli'];
/** Packages that are source-only on purpose (test support, never built): skipped with a note. */
const SOURCE_ONLY = new Set(['fixture-app']);
/** Intentional `exports` patterns (`<package dir><key>`, for example `core./internal/*`): not loaded, not a problem. */
const PATTERN_ALLOWED = new Set();
/** Conditions Node always has, or that name types only; every other condition gets its own pass. */
const BASE_CONDITIONS = new Set(['import', 'require', 'default', 'types', 'node', 'node-addons', 'module-sync']);
/** A bin run with `--help` must exit 0; `bin.ts` maps any rejected `main` to 2, which would hide a failed load. */
const BIN_OK = [0];
/** Traced runs in flight at once. */
const MAX_PARALLEL = 4;

const die = (msg) => {
  console.error(`check-bundle-plugins: ${msg}`);
  process.exit(1);
};
const rawTimeout = process.env.BUNDLE_CHECK_TIMEOUT_MS ?? '60000';
if (!/^[1-9]\d{0,5}$/.test(rawTimeout) || Number(rawTimeout) > 600_000)
  die('BUNDLE_CHECK_TIMEOUT_MS must be an integer from 1 to 600000');
const TIMEOUT_MS = Number(rawTimeout);

const argRoot = process.argv[2] === '--root' ? process.argv[3] : undefined;
if (process.argv.length > 2 && argRoot === undefined) {
  console.error('usage: check-bundle-plugins.mjs [--root <repo>]');
  process.exit(2);
}
const root = canonical(resolve(argRoot ?? join(HERE, '..')));
const packagesDir = join(root, 'packages');
const exempt = new Set([HOOK, DRIVER].map((p) => norm(canonical(p))));
const problems = [];
const notes = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const live = new Set();
/** Kills the child's own process group (the caller makes sure the group still exists: a pid can be reused). */
const killGroup = (child) => {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
};
const groupAlive = (child) => {
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** Kills a tracked run's group only if its leader still runs or the group is proven alive (a reaped pid can be reused). */
const killIfAlive = (handle) => {
  if (!handle.exited || groupAlive(handle.child)) killGroup(handle.child);
};
const cleanupLive = () => {
  for (const handle of live) {
    killIfAlive(handle);
    rmSync(handle.dir, { recursive: true, force: true });
  }
  live.clear();
};
process.on('exit', cleanupLive);
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143], ['SIGHUP', 129]]) process.on(sig, () => process.exit(code));

const hookOptions = (base) => [base, `--require ${JSON.stringify(HOOK)}`].filter((x) => x !== undefined && x !== '').join(' ');

/** Validates one parsed trace line; anything else is a malformed (possibly forged) line. */
const valid = (e) => {
  if (e === null || typeof e !== 'object') return false;
  const str = (v) => typeof v === 'string';
  if (e.t === 'edge') return (e.from === null || str(e.from)) && str(e.to);
  if (e.t === 'load') return str(e.url);
  if (e.t === 'hooks') return str(e.api) && (e.from === null || str(e.from));
  return e.t === 'done';
};
const parseTrace = (text, where) => {
  const events = [];
  const bad = [];
  const lines = text.split('\n');
  const tail = lines.pop();
  if (tail !== '') bad.push(`${where}: unterminated trace line`);
  for (const line of lines) {
    try {
      const e = JSON.parse(line);
      if (valid(e)) events.push(e);
      else bad.push(`${where}: unexpected trace event`);
    } catch {
      bad.push(`${where}: malformed trace line`);
    }
  }
  return { events, bad };
};

/**
 * Runs `node <args>` under the hook in its own process group; returns what the parent saw.
 * Settles on the main process exit, then reads the FIFO until every writer is gone (all traced
 * descendants hold a write end), bounded by the timeout; a descendant alive at the deadline is a timeout.
 */
const traced = async (args, { scrub = false } = {}) => {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-load-'));
  const fifo = join(dir, 'trace');
  let rfd = -1;
  let wfd = -1;
  try {
    const mk = spawnSync('mkfifo', [fifo]);
    if (mk.status !== 0) throw new Error(`cannot create the trace FIFO (${mk.error?.message ?? mk.stderr}); the check needs a POSIX system with mkfifo`);
    rfd = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
    wfd = openSync(fifo, constants.O_WRONLY);
    const env = scrub
      ? { PATH: process.env.PATH, NODE_OPTIONS: hookOptions(undefined) }
      : { ...process.env, NODE_OPTIONS: hookOptions(process.env.NODE_OPTIONS), FLOWCTL_TRACE_SEEN: undefined };
    env.FLOWCTL_TRACE_FIFO = fifo;
    const child = spawn(process.execPath, ['--experimental-import-meta-resolve', '--require', HOOK, ...args], {
      cwd: dir,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
      env,
    });
    const handle = { child, dir, exited: false };
    live.add(handle);
    let pipeText = '';
    let fifoText = '';
    let stderr = '';
    let flood = false;
    child.stdio[3].setEncoding('utf8');
    child.stdio[3].on('data', (c) => {
      pipeText += c;
      if (pipeText.length > MAX_TRACE) flood = true;
    });
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => (stderr = (stderr + c).slice(-4000)));
    let status = null;
    let signal = null;
    let exited = false;
    child.on('exit', (code, sig) => {
      exited = true;
      handle.exited = true;
      status = code;
      signal = sig;
    });
    const decoder = new StringDecoder('utf8');
    const buf = Buffer.allocUnsafe(65536);
    const pump = () => {
      for (;;) {
        let n;
        try {
          n = readSync(rfd, buf, 0, buf.length, null);
        } catch (e) {
          if (e?.code === 'EAGAIN') return false;
          throw e;
        }
        if (n === 0) return true;
        fifoText += decoder.write(buf.subarray(0, n));
        if (fifoText.length > MAX_TRACE) {
          flood = true;
          return true;
        }
      }
    };
    const deadline = Date.now() + TIMEOUT_MS;
    let timedOut = false;
    let wClosed = false;
    let quietSince = null;
    for (;;) {
      const eof = pump();
      if (flood) break;
      if (exited && !wClosed) {
        closeSync(wfd);
        wfd = -1;
        wClosed = true;
        continue;
      }
      if (exited && eof && !groupAlive(child)) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= SETTLE_MS) break;
      } else quietSince = null;
      if (Date.now() > deadline) {
        timedOut = true;
        break;
      }
      await sleep(5);
    }
    killIfAlive(handle);
    await Promise.race([new Promise((r) => child.stderr.on('close', r)), sleep(300)]);
    live.delete(handle);
    return { pipeText, fifoText, status, signal, timedOut, flood, stderr };
  } finally {
    for (const h of live) {
      if (h.dir !== dir) continue;
      killIfAlive(h);
      live.delete(h);
    }
    for (const fd of [rfd, wfd]) {
      try {
        if (fd >= 0) closeSync(fd);
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true });
  }
};

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
/** Every leaf target of an exports value with the condition names on its way: `[{ path, leaf }]`. */
const leafPaths = (v, path = []) =>
  typeof v === 'string'
    ? [{ path, leaf: v }]
    : Array.isArray(v)
      ? v.flatMap((x) => leafPaths(x, path))
      : v !== null && typeof v === 'object'
        ? Object.entries(v).flatMap(([k, x]) => leafPaths(x, k.startsWith('.') ? path : [...path, k]))
        : [];
/**
 * True for a subpath that nothing executes: every leaf sits under a `types` condition, or is the
 * package.json itself. A `.d.ts` target under another condition, or as a plain string, is not skipped:
 * the driver tries it and rejects it as "TypeScript source, not built", which fails the run.
 */
const inert = (target) => leafPaths(target).every(({ path, leaf }) => path.includes('types') || /(^|\/)package\.json$/.test(leaf));
/** Distinct condition sets (without the base ones) on root-to-leaf paths; each is one extra pass. */
const conditionSets = (exp) => {
  const sets = new Map();
  for (const { path } of leafPaths(exp)) {
    const set = [...new Set(path.filter((c) => !BASE_CONDITIONS.has(c) || c === 'require'))].sort();
    if (set.length > 0 && !(set.length === 1 && set[0] === 'require')) sets.set(set.join(','), set);
  }
  return [...sets.values()];
};
const hasRequire = (exp) => leafPaths(exp).some(({ path }) => path.includes('require'));

/** Entry subpaths, condition passes and bin files of a package, read as data; Node resolves them in the driver. */
const entriesOf = (dirName, dir) => {
  const pj = readJson(join(dir, 'package.json'));
  const exp = pj.exports;
  if (exp !== undefined && typeof pj.name !== 'string') problems.push(`packages/${dirName}/package.json: has exports but no name; Node cannot resolve it by name`);
  const subpathForm = exp !== null && typeof exp === 'object' && !Array.isArray(exp) && Object.keys(exp).some((k) => k.startsWith('.'));
  let specs = ['.'];
  if (subpathForm) {
    specs = [];
    for (const [k, target] of Object.entries(exp)) {
      if (!k.startsWith('.')) continue;
      if (k.includes('*')) {
        if (PATTERN_ALLOWED.has(`${dirName}${k}`)) notes.push(`${dirName}: exports pattern ${k} is allow-listed; not loaded`);
        else problems.push(`packages/${dirName}/package.json: exports pattern ${k} cannot be enumerated and so is not checked; list files, or add "${dirName}${k}" to PATTERN_ALLOWED`);
      } else if (!inert(target)) specs.push(k);
    }
  }
  const bin = typeof pj.bin === 'string' ? [pj.bin] : pj.bin !== null && typeof pj.bin === 'object' ? Object.values(pj.bin) : [];
  return {
    specs,
    modes: hasRequire(exp) ? ['import', 'require'] : ['import'],
    extra: conditionSets(exp),
    bins: bin.filter((b) => typeof b === 'string').map((b) => resolve(dir, b)),
  };
};

/** Package names a workspace package.json depends on, plus the names listed in the lockfile. */
const declaredPackages = () => {
  const names = new Set();
  const addJson = (file) => {
    try {
      const pj = readJson(file);
      for (const f of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
        for (const n of Object.keys(pj[f] ?? {})) names.add(n);
    } catch {}
  };
  addJson(join(root, 'package.json'));
  for (const d of readdirSync(packagesDir, { withFileTypes: true })) if (d.isDirectory()) addJson(join(packagesDir, d.name, 'package.json'));
  let lock = '';
  try {
    lock = readFileSync(join(root, 'bun.lock'), 'utf8');
  } catch {}
  const addKey = (key) => {
    const segs = key.split('/');
    names.add(key);
    names.add(segs.at(-1));
    if (segs.length >= 2) names.add(segs.slice(-2).join('/'));
  };
  try {
    const parsed = JSON.parse(lock.replace(/,(\s*[}\]])/g, '$1'));
    for (const [key, tuple] of Object.entries(parsed.packages ?? {})) {
      addKey(key);
      const real = Array.isArray(tuple) && typeof tuple[0] === 'string' ? tuple[0].replace(/@[^@/]*$/, '') : '';
      if (real !== '') addKey(real);
    }
  } catch {
    for (const m of lock.matchAll(/^ {4}"([^"]+)": \[/gm)) addKey(m[1]);
  }
  return names;
};

const exitText = (run) => (run.signal === null ? `exit ${run.status}` : `child killed by signal ${run.signal}`);

const checkRun = (name, run, { requireDone, okCodes }) => {
  const a = parseTrace(run.pipeText, name);
  const b = parseTrace(run.fifoText, name);
  problems.push(...new Set([...a.bad, ...b.bad]));
  const events = [...a.events, ...b.events];
  if (run.flood) problems.push(`${name}: the trace exceeded ${MAX_TRACE} bytes; refusing to continue (flood)`);
  else if (run.timedOut) problems.push(`${name}: did not finish within ${TIMEOUT_MS / 1000}s (an entry that never settles, or a descendant still running?)`);
  else if (requireDone && run.status !== 0) {
    const missing = /ERR_MODULE_NOT_FOUND|Cannot find module/.test(run.stderr) ? ' (run `bun run build` first; is dist partial?)' : '';
    const lines = run.stderr.trim().split('\n');
    const errors = lines.filter((l) => /Error|resolves outside/.test(l)).slice(0, 3);
    problems.push(`${name}: failed to load (${exitText(run)})${missing}: ${(errors.length > 0 ? errors : lines.slice(-3)).join(' | ')}`);
  } else if (requireDone && !events.some((e) => e.t === 'done')) {
    problems.push(`${name}: the entries did not report done (the process exited before every import settled)`);
  } else if (!requireDone && !okCodes.includes(run.status)) {
    problems.push(`${name}: ${exitText(run)}, expected ${okCodes.join(' or ')}: ${run.stderr.trim().split('\n').slice(-2).join(' | ')}`);
  }
  if (!events.some((e) => e.t === 'edge' || e.t === 'load')) problems.push(`${name}: the load hook recorded nothing; refusing to pass on an empty trace`);
  problems.push(...analyse(name, events, { root, exempt, declared }));
};

const targets = [];
for (const d of readdirSync(packagesDir, { withFileTypes: true })) {
  if (/^plugin-/i.test(d.name)) continue;
  if (d.name.startsWith('.') && d.isFile()) continue;
  const dir = join(packagesDir, d.name);
  if (!d.isDirectory()) {
    problems.push(`packages/${d.name}: not a plain directory; links and files in packages/ hide code from the check`);
    continue;
  }
  if (SOURCE_ONLY.has(d.name)) {
    notes.push(`packages/${d.name}: source-only package (allowlisted); skipped`);
    continue;
  }
  if (!existsSync(join(dir, 'package.json'))) {
    problems.push(`packages/${d.name}: no package.json; cannot find its entry point`);
    continue;
  }
  try {
    targets.push({ name: d.name, dir: canonical(dir), ...entriesOf(d.name, dir) });
  } catch (e) {
    problems.push(`packages/${d.name}/package.json: cannot be read (${e?.message ?? e})`);
  }
}
for (const r of REQUIRED)
  if (!targets.some((t) => t.name === r)) problems.push(`required package ${r} was not found under packages/; refusing to check without it`);
const declared = declaredPackages();

try {
  const jobs = [];
  for (const t of targets) {
    const passes = [
      { label: t.name, flags: [], modes: t.modes },
      ...t.extra.map((set) => ({ label: `${t.name} [conditions ${set.join(',')}]`, flags: set.flatMap((c) => ['--conditions', c]), modes: t.modes })),
    ];
    for (const p of passes)
      jobs.push({ label: p.label, args: [...p.flags, DRIVER, t.dir, JSON.stringify(t.specs), JSON.stringify(p.modes)], check: { requireDone: true } });
    for (const bin of t.bins) {
      const label = `${t.name} bin ${bin.slice(t.dir.length + 1)}`;
      if (!bin.startsWith(t.dir + sep) || !existsSync(bin)) problems.push(`${label}: missing or outside the package; run \`bun run build\` first`);
      else jobs.push({ label, args: [bin, '--help'], opts: { scrub: true }, check: { requireDone: false, okCodes: BIN_OK } });
    }
  }
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const i = next++;
      const j = jobs[i];
      results[i] = await traced(j.args, j.opts);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_PARALLEL, jobs.length) }, worker));
  jobs.forEach((j, i) => checkRun(j.label, results[i], j.check));
} catch (e) {
  die(e?.message ?? String(e));
}

for (const n of notes) console.log(`check-bundle-plugins: note: ${n}`);
if (problems.length > 0) {
  console.error(`check-bundle-plugins: ${new Set(problems).size} problem(s)\n${[...new Set(problems)].join('\n')}`);
  process.exit(1);
}
console.log(`check-bundle-plugins: ok (${targets.map((t) => t.name).join(', ')})`);
