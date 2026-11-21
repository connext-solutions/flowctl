/**
 * The Kiro CLI arm of the comparison: `kiro-cli chat` headless, with a dedicated agent that loads only the Chrome
 * DevTools MCP server, on the same prompts as the Claude Code arm. Costs come in Kiro credits, not USD.
 *
 * @remarks The agent config is written to `~/.kiro/agents/flowctl-bench-devtools.json` (the CLI finds agents by
 *   name only there or in `<cwd>/.kiro/agents`, and every run starts in an empty temp dir) and validated with
 *   `kiro-cli agent validate` before the first run. Nothing else under `~/.kiro` is touched.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseVerdict, promptFor } from './compare-prompt.mjs';

const HOME = process.env.HOME ?? '';
const KIRO = process.env.KIRO_BIN ?? join(HOME, '.local/bin/kiro-cli');
const AGENT = 'flowctl-bench-devtools';
const MODEL = 'claude-sonnet-5.5';
const ARM = 'llm-kiro-devtools';
/** Wall-clock cap per run; the process group is killed and the run recorded as `timeout`. */
const RUN_CAP_MS = 10 * 60 * 1000;
/** Probe only: one clean case and two seeded bugs from two other flows, one run each. */
export const KIRO_PROBE = ['leave-submit/clean', 'leave-approve/wrongBody', 'leave-persist/notPersisted'];

/** The same DevTools server and flags as the Claude Code arm (`llmArm` in compare.mjs). */
const AGENT_CONFIG = {
  name: AGENT,
  description: 'Benchmark agent: Chrome DevTools MCP only, no built-in tools, no resources.',
  prompt: 'You verify web app flows in a browser using only the Chrome DevTools tools.',
  mcpServers: {
    'chrome-devtools': {
      command: 'npx',
      args: ['-y', 'chrome-devtools-mcp@1.13.0', '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux', '--maxNavigationSaved', '25', '--viewport', '1280x720'],
    },
  },
  tools: ['@chrome-devtools'],
  toolAliases: {},
  allowedTools: ['@chrome-devtools'],
  resources: [],
  hooks: [],
  toolsSettings: {},
  includeMcpJson: false,
  model: MODEL,
  permissions: { rules: [{ capability: 'mcp', match: ['chrome-devtools/*'], effect: 'allow' }] },
};

function installAgent() {
  const dir = join(HOME, '.kiro/agents');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${AGENT}.json`);
  writeFileSync(path, `${JSON.stringify(AGENT_CONFIG, null, 2)}\n`);
  const v = spawnSync(KIRO, ['agent', 'validate', '--path', path], { encoding: 'utf8' });
  if (v.status !== 0) throw new Error(`kiro-cli agent validate failed: ${(v.stderr || v.stdout).slice(-300)}`);
}

/** The `_meta.kiro` payload of a stream event, if any. */
const kiroMeta = (e) => e?.data?.update?._meta?.kiro;

/**
 * Usage figures from the `stream-json` events of one run.
 *
 * @remarks `contextTokens` is the largest `breakdown` the stream carried. The v3 engine sends it at session start
 *   and turn end only, without tool results or responses, so it measures the fixed overhead (tool definitions,
 *   prompt), not the context at its peak; `maxContextPercent` is the largest `usagePercentage` of the window.
 */
export function summarize(events) {
  const metas = events.map(kiroMeta).filter(Boolean);
  const usage = metas.findLast((k) => k.kind === 'session_usage');
  const turns = metas.filter((k) => k.kind === 'turn_completion');
  let context = null;
  for (const k of metas) {
    const b = k.breakdown;
    if (b === undefined) continue;
    const total = Object.values(b).reduce((n, v) => n + (v?.tokens ?? 0), 0);
    if (context === null || total > context.total)
      context = {
        total,
        tools: b.tools?.tokens ?? 0,
        toolsMcp: b.tools?.mcp?.tokens ?? 0,
        toolsBuiltin: b.tools?.builtin?.tokens ?? 0,
        prompts: b.yourPrompts?.tokens ?? 0,
        responses: b.kiroResponses?.tokens ?? 0,
        contextFiles: b.contextFiles?.tokens ?? 0,
        contextFileItems: b.contextFiles?.items?.length ?? 0,
        memory: b.memory?.tokens ?? 0,
        sessionFiles: b.sessionFiles?.tokens ?? 0,
      };
  }
  const models = events
    .flatMap((e) => e?.data?.update?.configOptions ?? [])
    .filter((o) => o.id === 'model')
    .map((o) => o.currentValue);
  const updates = events.map((e) => e?.data?.update).filter(Boolean);
  const finished = events.findLast((e) => e.type === 'runFinished')?.data;
  return {
    credits: usage === undefined ? null : (usage.credits ?? []).reduce((n, c) => n + (c.usage ?? 0), 0),
    elapsedMs: turns.reduce((n, k) => n + (k.elapsedTime ?? 0), 0),
    numTurns: turns.length,
    toolCalls: updates.filter((u) => u.sessionUpdate === 'tool_call').length,
    toolNames: [...new Set(updates.filter((u) => u.sessionUpdate === 'tool_call').map((u) => u.title ?? u.kind ?? '?'))],
    contextTokens: context,
    maxContextPercent: Math.max(0, ...metas.map((k) => k.contextUsage?.usagePercentage ?? k.usagePercentage ?? 0)),
    model: models.at(-1) ?? null,
    stopReason: finished?.stopReason ?? null,
    finalText: finished?.finalText ?? null,
  };
}

/** Runs `kiro-cli chat` once in `cwd`; resolves with the parsed events, the exit and the wall time. */
function kiro(prompt, cwd, env) {
  const args = ['chat', '--no-interactive', '--output-format', 'stream-json', '--model', MODEL, '--agent', AGENT, '--trust-tools=@chrome-devtools', '--require-mcp-startup', prompt];
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const p = spawn(KIRO, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    const kill = (sig) => {
      try {
        process.kill(-p.pid, sig);
      } catch {
        /* already gone */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
      setTimeout(() => kill('SIGKILL'), 5000).unref();
    }, RUN_CAP_MS);
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => {
      clearTimeout(timer);
      kill('SIGKILL');
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
      resolve({ events, code, timedOut, stderrTail: err.slice(-300), wallMs: Math.round(performance.now() - started) });
    });
  });
}

/**
 * The Kiro arm: the probe cases once each, sequential, a fresh fixture and a fresh empty working directory per run.
 *
 * @param cases - every case of the comparison.
 * @param h - helpers from compare.mjs: `withFixture`, `flowDoc`, `record`, `correct`, `lines`.
 */
export async function kiroArm(cases, h) {
  installAgent();
  const env = { ...process.env };
  delete env.TYPESAFE_API_KEY;
  for (const id of KIRO_PROBE) {
    const c = cases.find((x) => x.id === id);
    if (h.lines().some((l) => l.arm === ARM && l.case === id)) continue;
    const uid = Math.random().toString(36).slice(2, 10);
    const line = await h.withFixture(c.bug, async (url) => {
      const cwd = mkdtempSync(join(tmpdir(), 'flowctl-bench-kiro-'));
      try {
        const r = await kiro(promptFor(h.flowDoc(c.flow), url, uid), cwd, env);
        const s = summarize(r.events);
        const failed = r.timedOut || r.code !== 0 || s.finalText === null;
        const parsed = parseVerdict(s.finalText);
        const verdict = r.timedOut ? 'timeout' : failed && parsed.verdict === 'no_verdict' ? 'error' : parsed.verdict;
        return {
          arm: ARM,
          case: c.id,
          flow: c.flow,
          bug: c.bug,
          expected: c.expected,
          rep: 1,
          verdict,
          correct: h.correct(verdict, c.expected),
          verdictLineStrict: parsed.strict,
          wallMs: r.wallMs,
          durationMs: s.elapsedMs,
          durationApiMs: null,
          numTurns: s.numTurns,
          toolCalls: s.toolCalls,
          toolNames: s.toolNames,
          terminalReason: r.timedOut ? 'timeout' : s.stopReason,
          error: verdict === 'error' ? `exit ${r.code}: ${r.stderrTail.replaceAll(HOME, '~')}` : null,
          model: s.model,
          costUsd: null,
          costUnit: 'kiro-credit',
          credits: s.credits,
          contextTokens: s.contextTokens,
          maxContextPercent: s.maxContextPercent,
        };
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    });
    h.record(line);
  }
  return 'done';
}
