#!/usr/bin/env node
/**
 * Opt-in benchmark: an LLM agent (headless Claude Code with the Chrome DevTools MCP) against flowctl (explore with
 * the real System 1, then model-free replay) on the fixture app's four flows, clean and with each seeded bug.
 * Appends one line per run to `docs/benchmarks/compare/results.jsonl`; `--report` prints the tables.
 *
 * @remarks Never runs in CI or `bun run verify`: it starts browsers, calls billed models and takes about an hour.
 *   The LLM arm needs a working `claude` login; the explore arm needs `TYPESAFE_API_KEY` in the environment.
 *   Spend limits (see `LIMITS`) are enforced from the lines already in the results file, so a rerun continues
 *   where the last one stopped instead of starting the budget again.
 * @example
 *   node scripts/bench/compare.mjs --arm replay
 *   set -a; . <path>/spike/.env; set +a; node scripts/bench/compare.mjs --arm explore
 *   node scripts/bench/compare.mjs --arm llm
 *   node scripts/bench/compare.mjs --report
 */
import { spawn } from 'node:child_process';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseVerdict, promptFor } from './compare-prompt.mjs';
import { report } from './compare-report.mjs';

/** The fixture app ships TypeScript source with `.js` specifiers; map them to the `.ts` files for Node's type stripping. */
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith('.') && spec.endsWith('.js') && ctx.parentURL?.endsWith('.ts')) {
      const ts = new URL(spec.replace(/\.js$/, '.ts'), ctx.parentURL);
      if (existsSync(fileURLToPath(ts))) return next(ts.href, ctx);
    }
    return next(spec, ctx);
  },
});

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const fromCore = createRequire(join(ROOT, 'packages/core/package.json'));
/** A dependency of core, by its package name; CommonJS packages come back as their exports object. */
const load = async (spec) => {
  const m = await import(pathToFileURL(fromCore.resolve(spec)).href);
  return m.default ?? m;
};
const core = await import(pathToFileURL(join(ROOT, 'packages/core/dist/index.js')).href);
const { progressView, replayView } = await import(pathToFileURL(join(ROOT, 'packages/mcp/dist/shape.js')).href);
const fixture = await import(pathToFileURL(join(ROOT, 'packages/fixture-app/src/index.ts')).href);
const { chromium } = await load('playwright');
const YAML = await load('yaml');

const RESULTS = join(ROOT, 'docs/benchmarks/compare/results.jsonl');
const PROFILES = ['employee', 'manager'];
const SYSTEM1_URL = 'https://api.typesafe.ai';
const CLAUDE = process.env.CLAUDE_BIN ?? join(process.env.HOME ?? '', '.local/bin/claude');
const DEVTOOLS_MCP = 'chrome-devtools-mcp@1.13.0';
const MODEL = 'sonnet';
const MAX_TURNS = 30;

/** Spend control for the LLM arm (USD as reported by the CLI) and the System 1 arm. */
const LIMITS = {
  probeCases: 3,
  probeMaxAvgUsd: 0.6,
  perCase: 3,
  maxRuns: 60,
  maxTotalUsd: 12,
  perRunUsd: 1,
  exploreRetries: 2,
  replayPerCase: 3,
};

/**
 * Ground truth: the flow each seeded bug must turn red, from `CAUGHT_BY` in
 * `packages/core/test/seeded-bugs.accuracy.test.ts` (and the fixture README table).
 */
const CAUGHT_IN = {
  save500: 'leave-submit',
  notPersisted: 'leave-persist',
  wrongBody: 'leave-approve',
  toastOnFail: 'leave-submit',
  noValidation: 'leave-validation',
  consoleError: 'leave-approve',
  list500: 'leave-persist',
  wrongValueAfterReload: 'leave-persist',
  approve403: 'leave-approve',
  approveNoop: 'leave-approve',
  redirectWrong: 'leave-submit',
  formNotReset: 'leave-submit',
  toastInList: 'leave-submit',
};
const FLOWS = ['leave-approve', 'leave-persist', 'leave-submit', 'leave-validation'];

/** Every case: each flow on the clean app (expected `passed`), and each bug in the flow that catches it (`failed`). */
export const CASES = [
  ...FLOWS.map((flow) => ({ id: `${flow}/clean`, flow, bug: null, expected: 'passed' })),
  ...fixture.BUG_MODES.map((bug) => ({ id: `${CAUGHT_IN[bug]}/${bug}`, flow: CAUGHT_IN[bug], bug, expected: 'failed' })),
];
/** The first LLM-arm runs, used to estimate the cost per run before spending more. */
const PROBE = ['leave-submit/clean', 'leave-approve/clean', 'leave-validation/noValidation'];

const flowDoc = (name) => YAML.parse(readFileSync(join(fixture.FIXTURE_FLOWS_DIR, `${name}.yaml`), 'utf8'));
const lines = () =>
  existsSync(RESULTS)
    ? readFileSync(RESULTS, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
function record(line) {
  mkdirSync(dirname(RESULTS), { recursive: true });
  appendFileSync(RESULTS, `${JSON.stringify({ at: new Date().toISOString(), ...line })}\n`);
  const cost = typeof line.costUsd !== 'number' ? '' : ` $${line.costUsd.toFixed(4)}`;
  process.stderr.write(`${line.arm} ${line.case} #${line.rep}: ${line.verdict} (${line.wallMs} ms)${cost}\n`);
}
const correct = (verdict, expected) => (verdict === 'passed' || verdict === 'failed' ? verdict === expected : false);
const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

/** A flowctl config in a fresh temp dir, like core's test helpers (`fixtureConfig`, `exploreConfig`). */
function config(baseUrl, extra = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-bench-'));
  const cfg = core.parseConfig(
    {
      defaultEnv: 'local',
      envs: { local: { baseUrl, loginUrl: '/login' } },
      profiles: { employee: {}, manager: {} },
      assertTimeout: 3000,
      stepTimeout: 3000,
      ...extra,
    },
    root,
  );
  return { cfg, root };
}

/** Saves a storage state per profile through the fixture's `/login?as=<profile>`, like core's `seedProfiles`. */
async function seedProfiles(browser, cfg, baseUrl) {
  for (const profile of PROFILES) {
    const context = await browser.newContext({ baseURL: baseUrl });
    const page = await context.newPage();
    await page.goto(`/login?as=${profile}`);
    const path = core.storageStatePath(cfg, 'local', profile);
    mkdirSync(dirname(path), { recursive: true });
    await context.storageState({ path });
    await context.close();
  }
}

/** A fresh fixture with `bug` on and empty data for one run; closed afterwards. */
async function withFixture(bug, fn) {
  const f = await fixture.startFixture(bug ?? undefined);
  try {
    await fetch(`${f.url}/api/__reset`, { method: 'POST' });
    return await fn(f.url);
  } finally {
    await f.close();
  }
}

/** Model-free replay of the fixture's saved flow, `replayMany` as `flowctl replay` and the MCP `flow_replay` call it. */
async function replayArm(cases) {
  const browser = await chromium.launch();
  try {
    for (const c of cases) {
      const done = lines().filter((l) => l.arm === 'flowctl-replay' && l.case === c.id).length;
      for (let rep = done + 1; rep <= LIMITS.replayPerCase; rep++) {
        await withFixture(c.bug, async (url) => {
          const { cfg, root } = config(url);
          try {
            await seedProfiles(browser, cfg, url);
            mkdirSync(cfg.flowsPath, { recursive: true });
            cpSync(join(fixture.FIXTURE_FLOWS_DIR, `${c.flow}.yaml`), join(cfg.flowsPath, `${c.flow}.yaml`));
            const flows = core.findFlows(cfg.flowsPath, PROFILES, { names: [c.flow] });
            const started = performance.now();
            const s = await core.replayMany(cfg, flows, {});
            const wallMs = Math.round(performance.now() - started);
            const r = s.results[0];
            const verdict = r.status === 'passed' || r.status === 'failed' ? r.status : 'error';
            record({
              arm: 'flowctl-replay',
              case: c.id,
              flow: c.flow,
              bug: c.bug,
              expected: c.expected,
              rep,
              verdict,
              correct: correct(verdict, c.expected),
              wallMs,
              engineMs: r.ms,
              steps: r.steps,
              failedAssertion: r.failed?.assertion ?? null,
              error: r.error?.kind ?? null,
              modelTokens: 0,
              toolCalls: 1,
              resultBytes: bytes(replayView(s)),
            });
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        });
      }
    }
  } finally {
    await browser.close();
  }
}

/** System 1 decisions of a run, from its `decisions.jsonl`. */
function decisionsOf(cfg, runId) {
  const log = join(core.runsPath(cfg), runId, 'decisions.jsonl');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? null : s[Math.floor(s.length / 2)];
};

/** One exploration per flow on the clean app with the real System 1, the request built from the flow file. */
async function exploreArm() {
  if ((process.env.TYPESAFE_API_KEY ?? '') === '') throw new Error('TYPESAFE_API_KEY is not set; load it from spike/.env first');
  let retries = lines().filter((l) => l.arm === 'flowctl-explore' && l.retry === true).length;
  const browser = await chromium.launch();
  try {
    for (const flow of FLOWS) {
      const c = CASES.find((x) => x.id === `${flow}/clean`);
      if (lines().some((l) => l.arm === 'flowctl-explore' && l.case === c.id && l.retry !== true)) continue;
      for (;;) {
        const line = await withFixture(null, async (url) => {
          const { cfg, root } = config(url, {
            assertTimeout: 5000,
            system1: { baseUrl: SYSTEM1_URL, allowedEnvs: ['local'] },
          });
          try {
            await seedProfiles(browser, cfg, url);
            const doc = flowDoc(flow);
            const req = {
              goal: doc.goal,
              start: doc.start,
              profile: doc.profile,
              inputs: doc.inputs,
              assertions: doc.assertions,
            };
            const started = performance.now();
            const x = await core.Exploration.start(cfg, req, { browser });
            const stop = await x.advance();
            const wallMs = Math.round(performance.now() - started);
            const view = progressView(stop);
            const closed = stop.status === 'escalated' ? await x.finish() : undefined;
            const ds = decisionsOf(cfg, stop.runId);
            const verdict = stop.status;
            return {
              arm: 'flowctl-explore',
              case: c.id,
              flow,
              bug: null,
              expected: c.expected,
              rep: 1,
              verdict,
              correct: correct(verdict, c.expected),
              wallMs,
              runId: stop.runId,
              steps: stop.steps ?? null,
              escalation: stop.escalation?.reason ?? null,
              escalationDetail: stop.escalation?.detail ?? null,
              finishedAfterEscalation: closed?.status ?? null,
              failedAssertion: stop.failed?.assertion ?? null,
              error: stop.error?.kind ?? null,
              model: x.recording()?.model ?? 'unknown',
              decisions: ds.length,
              system1Ms: ds.reduce((n, d) => n + (d.ms ?? 0), 0),
              medianDecisionMs: median(ds.map((d) => d.ms)),
              tokens: 'unknown',
              costUsd: 'unknown',
              toolCalls: 1,
              resultBytes: bytes(view),
            };
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        });
        const unreachable = line.verdict === 'error' && /system1|network|unreachable|timeout/i.test(line.error ?? '');
        if (unreachable && retries < LIMITS.exploreRetries) {
          retries++;
          record({ ...line, retry: true });
          continue;
        }
        record(line);
        break;
      }
    }
  } finally {
    await browser.close();
  }
}

/** Environment for the LLM arm's process: no System 1 key, nothing else changed. */
function llmEnv() {
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  return env;
}

/** Runs `claude -p` once; resolves with the final `result` event, the tool calls it made and the wall time. */
function claude(prompt, cwd, mcpConfig) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--model',
    MODEL,
    '--max-turns',
    String(MAX_TURNS),
    '--max-budget-usd',
    String(LIMITS.perRunUsd),
    '--mcp-config',
    mcpConfig,
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--tools',
    '',
    '--allowedTools',
    'mcp__chrome-devtools',
    '--disallowedTools',
    'Bash Edit Write',
    '--permission-mode',
    'dontAsk',
    '--disable-slash-commands',
    '--no-session-persistence',
  ];
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const p = spawn(CLAUDE, args, { cwd, env: llmEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      const events = out
        .split('\n')
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        });
      const toolCalls = events
        .filter((e) => e.type === 'assistant')
        .flatMap((e) => e.message?.content ?? [])
        .filter((b) => b.type === 'tool_use').length;
      resolve({
        result: events.findLast((e) => e.type === 'result'),
        toolCalls,
        code,
        stderrTail: err.slice(-300),
        wallMs: Math.round(performance.now() - started),
      });
    });
  });
}

/** The LLM arm, with the probe gate and the budget checked from the results file before every run. */
async function llmArm(cases) {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-bench-llm-'));
  const mcpConfig = join(dir, 'mcp.json');
  writeFileSync(
    mcpConfig,
    JSON.stringify({
      mcpServers: {
        'chrome-devtools': {
          command: 'npx',
          args: ['-y', DEVTOOLS_MCP, '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', '--maxNavigationSaved', '25', '--viewport', '1280x720'],
        },
      },
    }),
  );
  const cwd = join(dir, 'cwd');
  mkdirSync(cwd);
  const counted = () => lines().filter((l) => l.arm === 'llm-devtools' && l.verdict !== 'error');
  const spent = () => counted().reduce((n, l) => n + (l.costUsd ?? 0), 0);
  const order = [...PROBE.map((id) => cases.find((c) => c.id === id)).filter(Boolean), ...cases.filter((c) => !PROBE.includes(c.id))];
  try {
    for (let rep = 1; rep <= LIMITS.perCase; rep++) {
      for (const c of order) {
        const runs = counted();
        if (runs.filter((l) => l.case === c.id).length >= rep) continue;
        if (runs.length >= LIMITS.probeCases) {
          const avg = spent() / runs.length;
          if (runs.length === LIMITS.probeCases && avg > LIMITS.probeMaxAvgUsd)
            return `stopped after the probe: $${avg.toFixed(3)} per run is above $${LIMITS.probeMaxAvgUsd}`;
          if (runs.length >= LIMITS.maxRuns) return `stopped: ${LIMITS.maxRuns} runs`;
          if (spent() + avg > LIMITS.maxTotalUsd) return `stopped: $${spent().toFixed(2)} spent, the next run would pass $${LIMITS.maxTotalUsd}`;
        } else if (!PROBE.includes(c.id)) continue;
        const uid = Math.random().toString(36).slice(2, 10);
        const line = await withFixture(c.bug, async (url) => {
          const r = await claude(promptFor(flowDoc(c.flow), url, uid), cwd, mcpConfig);
          const res = r.result ?? {};
          const apiError = res.is_error === true && res.api_error_status !== undefined;
          const { verdict, strict } = apiError ? { verdict: 'error', strict: false } : parseVerdict(res.result);
          const u = res.usage ?? {};
          return {
            arm: 'llm-devtools',
            case: c.id,
            flow: c.flow,
            bug: c.bug,
            expected: c.expected,
            rep,
            verdict,
            correct: correct(verdict, c.expected),
            verdictLineStrict: strict,
            wallMs: r.wallMs,
            durationMs: res.duration_ms ?? null,
            durationApiMs: res.duration_api_ms ?? null,
            numTurns: res.num_turns ?? null,
            toolCalls: r.toolCalls,
            terminalReason: res.terminal_reason ?? res.subtype ?? null,
            error: apiError ? `${res.api_error_status} ${res.api_error_code ?? ''}`.trim() : null,
            model: Object.keys(res.modelUsage ?? {}).join(',') || null,
            costUsd: res.total_cost_usd ?? 0,
            inputTokens: u.input_tokens ?? 0,
            outputTokens: u.output_tokens ?? 0,
            cacheReadTokens: u.cache_read_input_tokens ?? 0,
            cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
          };
        });
        record(line);
        if (line.verdict === 'error') return `stopped: the model API refused the run (${line.error})`;
      }
    }
    return 'done';
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const { values } = parseArgs({
  options: {
    arm: { type: 'string' },
    report: { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
});
if (values.report === true) process.stdout.write(report(lines(), CASES));
else if (values['dry-run'] === true)
  for (const c of CASES) process.stdout.write(`--- ${c.id} (expected ${c.expected})\n${promptFor(flowDoc(c.flow), 'http://127.0.0.1:PORT', 'UID')}\n`);
else if (values.arm === 'replay') await replayArm(CASES);
else if (values.arm === 'explore') await exploreArm();
else if (values.arm === 'llm') process.stderr.write(`${await llmArm(CASES)}\n`);
else {
  process.stderr.write('usage: compare.mjs --arm replay|explore|llm | --report | --dry-run\n');
  process.exitCode = 2;
}
