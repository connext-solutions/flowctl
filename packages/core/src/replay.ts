import { chromium, type Browser } from 'playwright';
import { StepError, describeLoc } from './browser/index.js';
import { resolveEnv, type LoadedConfig } from './config.js';
import { healStep } from './explore/index.js';
import { updateLocators, type Flow, type Loc } from './flow/index.js';
import type {
  FlowSummary,
  ReplaySummary,
  RunResult,
  StepFailure,
  TraceMode,
} from './result.js';
import { RunSession, outcomeOf, toOutcome, type Outcome } from './run/index.js';
import { System1Client } from './system1/index.js';
import type { TrustStore } from './trust/index.js';

/**
 * Replays one flow: the recorded steps, then the deterministic assertions.
 *
 * @remarks
 * - Strict by default: a step whose locator matches 0 or more than 1 element fails the run and
 *   the assertions are not evaluated (ADR 0008).
 * - With `opts.system1` (heal) such a step is handed to System 1 once; a confident answer runs the
 *   step on that element and lists it in `healed`, with the old and new locator in `heals`. The flow file is
 *   updated only when the whole run passes **and** the caller confirmed with `opts.acceptHeals` (ADR 0008
 *   amendment, issue #48: page text can steer System 1, so a heal is never written silently); assertions are
 *   never touched. The caller obtains the client from `System1Client.fromConfig`, which enforces `allowedEnvs`.
 * @returns Always a {@link RunResult}; run-level problems become `status: 'error'`.
 * @throws {ConfigError} when `opts.env` is not a configured env.
 */
export async function replayFlow(
  cfg: LoadedConfig,
  flow: Flow,
  opts: {
    env?: string;
    browser: Browser;
    system1?: System1Client;
    store?: TrustStore;
    trace?: TraceMode;
    acceptHeals?: boolean;
  },
): Promise<RunResult> {
  const run = RunSession.open(cfg, flow, opts);
  const healed = new Map<number, Loc>();
  let written = false;
  let outcome: Outcome;
  let stepsDone = 0;
  try {
    await run.begin();
    let failedStep: StepFailure | undefined;
    for (const [i, step] of run.steps.entries()) {
      try {
        await run.perform(step);
      } catch (e) {
        if (!(e instanceof StepError)) throw e;
        const loc =
          e.kind === 'action_failed' || opts.system1 === undefined
            ? undefined
            : await healStep(run, step, i, {
                goal: flow.goal,
                system1: opts.system1,
                threshold: cfg.system1?.confidenceThreshold ?? 0.5,
              });
        if (loc === undefined) {
          failedStep = { step: i, kind: e.kind, message: e.message };
          break;
        }
        healed.set(i, loc);
      }
      stepsDone++;
    }
    if (failedStep !== undefined) {
      outcome = { status: 'failed', failed: failedStep };
    } else {
      outcome = outcomeOf(await run.check());
    }
    if (
      outcome.status === 'passed' &&
      healed.size > 0 &&
      opts.acceptHeals === true
    ) {
      updateLocators(flow.file, healed);
      written = true;
    }
  } catch (e) {
    outcome = toOutcome(e);
  }
  const heals = [...healed].map(([step, to]) => {
    const was = flow.parsedSteps[step];
    return {
      step,
      from:
        was !== undefined && 'target' in was ? describeLoc(was.target) : '?',
      to: describeLoc(to),
      written,
    };
  });
  return run.finish(outcome, stepsDone, { healed: [...healed.keys()], heals });
}

/**
 * Groups run results per flow and counts them.
 *
 * @remarks A flow whose runs disagree (e.g. `passed` then `failed` under `--repeat`) counts as
 *   flaky only; otherwise any `error` makes it an error, any `failed` a failure.
 */
export function summarize(results: RunResult[]): ReplaySummary {
  const byFlow = new Map<string, RunResult[]>();
  for (const r of results) {
    byFlow.set(r.flow, [...(byFlow.get(r.flow) ?? []), r]);
  }
  const flows: FlowSummary[] = [...byFlow.entries()].map(([flow, rs]) => {
    const statuses = rs.map((r) => r.status);
    return {
      flow,
      runs: rs.length,
      statuses,
      flaky: new Set(statuses).size > 1,
    };
  });
  const count = (pred: (f: FlowSummary) => boolean): number =>
    flows.filter(pred).length;
  return {
    results,
    flows,
    flaky: count((f) => f.flaky),
    passed: count((f) => !f.flaky && f.statuses.every((s) => s === 'passed')),
    errors: count((f) => !f.flaky && f.statuses.includes('error')),
    failed: count(
      (f) =>
        !f.flaky &&
        f.statuses.includes('failed') &&
        !f.statuses.includes('error'),
    ),
  };
}

/** CLI exit code: `2` if any flow errored, `1` if any failed or is flaky, else `0`. */
export const exitCodeFor = (s: ReplaySummary): 0 | 1 | 2 =>
  s.errors > 0 ? 2 : s.failed > 0 || s.flaky > 0 ? 1 : 0;

/**
 * Replays each flow `repeat` times in one shared browser and summarises the results.
 *
 * @param opts.heal hand broken locators to System 1 (`--heal`).
 * @param opts.acceptHeals write healed locators back into a flow whose run passed (`--accept-heals`).
 * @param opts.trace `full` records DOM snapshots and screenshots in the traces, with cookies and bodies (ADR 0030).
 * @throws {RunError} `system1_not_allowed` / {ConfigError} when heal is asked for but System 1 is
 *   not allowed on the env or not configured.
 */
export async function replayMany(
  cfg: LoadedConfig,
  flows: Flow[],
  opts: {
    env?: string;
    repeat?: number;
    headed?: boolean;
    heal?: boolean;
    store?: TrustStore;
    trace?: TraceMode;
    acceptHeals?: boolean;
  },
): Promise<ReplaySummary> {
  const system1 =
    opts.heal === true
      ? System1Client.fromConfig(cfg, resolveEnv(cfg, opts.env).name)
      : undefined;
  const browser = await chromium.launch({ headless: opts.headed !== true });
  try {
    const results: RunResult[] = [];
    for (const flow of flows) {
      for (let i = 0; i < (opts.repeat ?? 1); i++) {
        results.push(
          await replayFlow(cfg, flow, {
            env: opts.env,
            browser,
            system1,
            store: opts.store,
            trace: opts.trace,
            acceptHeals: opts.acceptHeals,
          }),
        );
      }
    }
    return summarize(results);
  } finally {
    await browser.close();
  }
}
