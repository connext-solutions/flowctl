import type { LoadedConfig, ResolvedEnv } from '../config.js';
import { weakLocators, type Flow, type Step } from '../flow/index.js';
import type { HealProposal, RunResult } from '../result.js';
import type { HookSession } from '../trust/index.js';
import type { Evidence } from './evidence.js';
import { system1Metrics } from './metrics.js';
import { runHookKind } from './hooks.js';
import { errorMessage, RunError, type Outcome } from './outcome.js';
import type { Send } from './ledger/index.js';
import type { ScopeGuard } from './scope-guard.js';
import type { Profiles } from './profiles.js';
import { redactText } from './redact.js';

/** What {@link finishRun} needs from a `RunSession`. */
export interface FinishInput {
  cfg: LoadedConfig;
  flow: Flow;
  env: ResolvedEnv;
  runId: string;
  started: number;
  evidence: Evidence;
  profiles: Profiles;
  setupStarted: boolean;
  prepared: boolean;
  /** The run's consented hooks and snapshot; `undefined` when the flow has none or consent failed. */
  hooks: HookSession | undefined;
  /** Resolved `{ env }` input values; masked as `***` in the result and `run.json`. */
  secrets: readonly string[];
  /**
   * The run's scope guard. Its request layer's run ledger (a replay on a `shared` env with stored confirmations) is
   * cleaned up before the contexts close, and its overrule is applied again after that cleanup.
   */
  guard?: ScopeGuard;
}

/**
 * Ends a run: the body of `RunSession.finish`, which documents the contract.
 *
 * @remarks The guard's overrule is applied again once the run ledger's cleanup is done: a create still in flight
 *   when the run ended, or a response scan that finished late, can bring a ledger problem (`ledger_replay`,
 *   `ledger_overflow`…) after the caller judged the outcome, and no verdict stands on such a run (ADR 0004).
 *
 *   Secret input values and credential-looking values (`password=…`, `Bearer …`, a JSON `token`, hook output
 *   included) are masked in `failed.got` and `error.hint` before `run.json` is written and before the result is
 *   returned, because a result reaches an orchestrator, which is a model (invariant 4, ADR 0030).
 * @see RunSession.finish
 */
export async function finishRun(
  run: FinishInput,
  outcome: Outcome,
  stepsDone: number,
  extra: { healed?: number[]; recorded?: Step[]; heals?: HealProposal[] } = {},
): Promise<RunResult> {
  const failures: string[] = [];
  const stage = async <T>(
    name: string,
    fn: () => Promise<T>,
  ): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      failures.push(`${name}: ${errorMessage(e)}`);
      return undefined;
    }
  };
  await run.evidence.video?.result(
    run.profiles.all.map(([, c]) => c.page),
    outcome,
  );
  const summary = (await stage('evidence', () =>
    run.evidence.collect(run.profiles.all, run.profiles.activePage),
  )) ?? {
    dir: run.evidence.dir,
    traces: [],
    network: [],
    console: [],
    trace: run.evidence.trace,
  };
  const ledger = run.guard?.writes?.ledger;
  const cleanup =
    ledger === undefined
      ? undefined
      : await stage('cleanup', () => ledger.finish(senderOf(run)));
  const judged = run.guard?.overrule(outcome) ?? outcome;
  await stage('close', () => run.profiles.closeAll());
  if (run.evidence.video !== undefined)
    summary.videos = run.evidence.video.files;
  let teardownFailed = false;
  let refused: RunError | undefined;
  const started =
    run.setupStarted || (run.flow.setup === undefined && run.prepared);
  const teardown = run.flow.teardown;
  const hooks = run.hooks;
  if (teardown !== undefined && started && hooks !== undefined) {
    try {
      teardownFailed = !(await runHookKind(hooks, 'teardown', run.cfg)).ok;
    } catch (e) {
      teardownFailed = true;
      if (e instanceof RunError && e.kind === 'hooks_untrusted') refused = e;
      else failures.push(`teardown: ${errorMessage(e)}`);
    }
  }
  hooks?.close();
  const final: Outcome =
    judged.status === 'error'
      ? judged
      : refused !== undefined
        ? { status: 'error', error: { kind: refused.kind, hint: refused.hint } }
        : failures.length > 0
          ? {
              status: 'error',
              error: {
                kind: 'internal',
                hint: `finish: ${failures.join('; ')}`,
              },
            }
          : judged;
  const result: RunResult = {
    runId: run.runId,
    flow: run.flow.name,
    env: run.env.name,
    ...final,
    steps: stepsDone,
    healed: extra.healed ?? [],
    ...(extra.heals === undefined || extra.heals.length === 0
      ? {}
      : { heals: extra.heals }),
    teardownFailed,
    ...(cleanup === undefined ? {} : { cleanup }),
    weakLocators: weakLocators(extra.recorded ?? run.flow.parsedSteps),
    evidence: summary,
    ms: Date.now() - run.started,
  };
  const metrics = system1Metrics(run.evidence.decisions);
  if (metrics !== undefined) result.system1 = metrics;
  maskResult(result, run.secrets);
  try {
    run.evidence.save(result);
  } catch (e) {
    if (result.status !== 'error')
      Object.assign(result, {
        status: 'error',
        failed: undefined,
        error: {
          kind: 'internal',
          hint: `finish: run.json: ${errorMessage(e)}`,
        },
      });
  }
  return result;
}

/**
 * Sends cleanup and verify requests with the session of the flow's own profile (else the first open one), from the
 * browser context, so they carry the cookies the run used; an unanswered request is `error`.
 */
function senderOf(run: FinishInput): Send {
  const contexts = run.profiles.all;
  const ctx = (contexts.find(([p]) => p === run.flow.profile) ??
    contexts[0])?.[1].context;
  return async (method, url) => {
    if (ctx === undefined) return 'error';
    try {
      const r = await ctx.request.fetch(url, {
        method,
        maxRedirects: 0,
        failOnStatusCode: false,
      });
      return r.status();
    } catch {
      return 'error';
    }
  };
}

function maskResult(result: RunResult, secrets: readonly string[]): void {
  const f = result.failed;
  if (f !== undefined)
    result.failed =
      'got' in f
        ? { ...f, got: redactText(f.got, secrets) }
        : { ...f, message: redactText(f.message, secrets) };
  if (result.error !== undefined)
    result.error = {
      ...result.error,
      hint: redactText(result.error.hint, secrets),
    };
}
