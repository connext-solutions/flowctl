import type { Browser } from 'playwright';
import { StepError, type PageSnapshot } from '../browser/index.js';
import { resolveEnv, type LoadedConfig } from '../config.js';
import { FlowError, joinSwitches, type By, type Step } from '../flow/index.js';
import type { RunResult } from '../result.js';
import {
  RequestGuard,
  RunError,
  RunSession,
  outcomeOf,
  toOutcome,
  type Outcome,
} from '../run/index.js';
import type { CheckedDriver, HistoryEntry } from '../system1/index.js';
import type { TrustStore } from '../trust/index.js';
import { StaleControl, actOp, directStep, type Acted } from './act.js';
import { ActionGuard, DestructiveAction, envClassFor } from './guard.js';
import { type Action } from './policy.js';
import { draftFlow, driverOrRefusal } from './request.js';
import {
  checkDirectedSteps,
  MAX_GOAL_CHARS,
  parseExploreRequest,
} from './validate.js';
import { hasActed, NOTHING_DONE, runLoop, type LoopState } from './loop.js';
import { RunView } from './run-view.js';
import type {
  DirectedStep,
  Escalated,
  ExploreRequest,
  ExploreStop,
  Recording,
} from './types.js';

/**
 * One exploration: System 1 drives a browser toward a goal, the orchestrator steps in when it
 * escalates, and every executed step is recorded for `saveExploration`.
 *
 * @example
 * const x = await Exploration.start(cfg, req, { browser });
 * let stop = await x.advance();
 * while (stop.status === 'escalated') stop = await x.step({ kind: 'click', control: 7 });
 * if (stop.status === 'passed') await saveExploration(cfg, x, { name, browser });
 * @remarks
 * - Before each decision the assertions are checked once without waiting; when all pass (and at
 *   least one describes state, not only `noConsoleErrors` / `absent`) the run ends `passed`.
 * - A DONE whose assertions still fail after `assertTimeout` is rejected and the best other
 *   operation runs; the 3rd rejection in a row escalates `done_rejected`. DONE is never a verdict.
 * - Escalates on BLOCKED, low confidence, `maxSteps`, 3 identical actions that do not change the
 *   page (`loop`), failing actions (`action_failed`) and, on a `shared` or `production` env, a click
 *   or Enter on a control that looks destructive (`destructive_action`, see `ActionGuard`). A request that looks
 *   destructive is stopped by `RequestGuard` and ends the run `error: destructive_blocked` at its next step or
 *   check; `allowDestructive` lifts it only for the orchestrator's own steps. An
 *   escalated run keeps its browser contexts open until {@link step}, {@link advance} or {@link finish}.
 * @see docs/adr/0001-system1-drives-system2-escalates.md
 * @see docs/adr/0019-exploration-loop.md
 */
export class Exploration {
  private readonly recorded: Step[] = [];
  private readonly history: HistoryEntry[] = [];
  private goal: string;
  private readonly state: LoopState = { rejectedDone: 0, model: 'unknown' };
  private final: RunResult | undefined;
  private ending: Promise<RunResult> | undefined;
  private readonly view: RunView;

  private constructor(
    private readonly cfg: LoadedConfig,
    private readonly req: ExploreRequest,
    private readonly run: RunSession,
    private readonly system1: CheckedDriver | undefined,
    private readonly guard: ActionGuard,
    private readonly writes: RequestGuard,
  ) {
    this.goal = req.goal;
    this.view = new RunView(run, this.history);
  }

  /**
   * Opens the run (setup hook, profile, start page). A refused System 1 or a failing setup ends it
   * at once with an `error` result, returned by {@link advance}.
   *
   * @remarks Outside `system1.allowedEnvs` the run ends `error: system1_not_allowed` before any
   *   page is opened (ADR 0005).
   * @throws {ConfigError} for an unknown env, a missing `system1` section, or an unset or malformed API key.
   * @throws {TrustError} `trust_tampered` when the trust store entry for the env's origin is not owner-signed.
   * @throws {FlowError} for a request that fails validation (`parseExploreRequest`) or an unknown profile.
   */
  static async start(
    cfg: LoadedConfig,
    request: ExploreRequest,
    opts: {
      env?: string;
      browser: Browser;
      vars?: NodeJS.ProcessEnv;
      store?: TrustStore;
    },
  ): Promise<Exploration> {
    const req = parseExploreRequest(request);
    if (!Object.hasOwn(cfg.profiles, req.profile))
      throw new FlowError(`unknown profile "${req.profile}"`);
    const resolved = resolveEnv(cfg, opts.env);
    const env = resolved.name;
    const envClass = envClassFor(new URL(resolved.baseUrl).origin, opts.store);
    const allow = req.allowDestructive === true;
    const words = cfg.target.destructiveWords;
    const guard = new ActionGuard(envClass, allow, words);
    const writes = new RequestGuard(envClass, allow, words);
    const driver = driverOrRefusal(cfg, env, opts.vars);
    const system1 = driver instanceof RunError ? undefined : driver;
    const run = RunSession.open(cfg, draftFlow(req), {
      env,
      browser: opts.browser,
      store: opts.store,
      writes,
    });
    const x = new Exploration(cfg, req, run, system1, guard, writes);
    try {
      if (driver instanceof RunError) throw driver;
      await run.begin();
    } catch (e) {
      await x.end(toOutcome(e));
    }
    return x;
  }

  get runId(): string {
    return this.run.runId;
  }

  /** Lets System 1 continue until the run passes, escalates or errors; returns the final result once ended. */
  async advance(): Promise<ExploreStop> {
    if (this.final !== undefined) return this.final;
    try {
      return await this.loop();
    } catch (e) {
      return this.end(toOutcome(e));
    }
  }

  /**
   * Runs orchestrator steps in order (recorded `by: system2`), then lets System 1 continue.
   *
   * @remarks A failing step escalates `action_failed` (also for failed validation or a refused navigation such as a
   *   template that expanded to another origin), unless the run itself was stopped: a scope or destructive-request
   *   refusal or the wall-clock budget ends it, since a step on a page the budget closed must not read as the app's.
   * @example x.step([{ kind: 'as', profile: 'manager' }, { kind: 'goto', url: '/approvals' }])
   */
  async step(s: DirectedStep | readonly unknown[]): Promise<ExploreStop> {
    if (this.final !== undefined) return this.final;
    try {
      for (const one of joinSwitches(
        checkDirectedSteps(s, this.cfg.profiles),
      )) {
        await this.writes.asOrchestrator(async () => {
          const acted = await directStep(this.run, one, this.guard);
          await this.record(acted, 'system2', one.kind);
        });
        this.run.assertInScope();
      }
    } catch (e) {
      try {
        this.run.assertInScope();
      } catch (stop) {
        return this.end(toOutcome(stop));
      }
      if (e instanceof DestructiveAction)
        return this.view.escalated('destructive_action', e.message);
      if (
        e instanceof StepError ||
        e instanceof StaleControl ||
        e instanceof FlowError ||
        (e instanceof RunError && e.kind === 'flow_invalid')
      )
        return this.view.escalated('action_failed', e.message);
      return this.end(toOutcome(e));
    }
    return this.advance();
  }

  /**
   * Adds a hint to the goal System 1 works toward; hints are not saved with the flow.
   *
   * @throws {FlowError} when the goal would exceed `MAX_GOAL_CHARS`.
   */
  hint(text: string): void {
    const goal = `${this.goal}\nHint: ${text}`;
    if (goal.length > MAX_GOAL_CHARS)
      throw new FlowError(
        `The goal and its hints would exceed ${MAX_GOAL_CHARS} characters; send a shorter hint.`,
      );
    this.goal = goal;
  }

  /**
   * Ends the run now: waits up to `assertTimeout` for the assertions; `passed` or `failed`.
   *
   * @remarks A run that has not acted yet ({@link hasActed}) ends `error: flow_invalid`: assertions that held on
   *   arrival verify nothing, and such a run has no step to save.
   */
  async finish(): Promise<RunResult> {
    if (this.final !== undefined) return this.final;
    try {
      if (!hasActed(this.history))
        return await this.end({
          status: 'error',
          error: {
            kind: 'flow_invalid',
            hint: `The exploration ended before ${NOTHING_DONE}: take a step or let System 1 continue before finishing.`,
          },
        });
      return await this.end(outcomeOf(await this.run.check()));
    } catch (e) {
      return this.end(toOutcome(e));
    }
  }

  /** What `saveExploration` writes; only for a run that ended `passed`. */
  recording(): Recording | undefined {
    if (this.final?.status !== 'passed') return undefined;
    return {
      request: this.req,
      env: this.run.env.name,
      steps: [...this.recorded],
      model: this.state.model,
    };
  }

  private loop(): Promise<ExploreStop> {
    return runLoop({
      cfg: this.cfg,
      req: this.req,
      run: this.run,
      system1: this.system1,
      view: this.view,
      history: this.history,
      goal: this.goal,
      state: this.state,
      act: (a, snap) => this.act(a, snap),
      end: (o) => this.end(o),
    });
  }

  private async act(
    a: Action,
    snap: PageSnapshot,
  ): Promise<Escalated | undefined> {
    try {
      await this.record(
        await actOp(this.run.ctx(), a, snap, this.guard),
        'system1',
        a.op,
        snap,
      );
    } catch (e) {
      this.run.assertInScope();
      if (e instanceof StaleControl) {
        this.history.push({ op: a.op, control: 'stale', changed: true });
        return undefined;
      }
      if (e instanceof DestructiveAction)
        return this.view.escalated('destructive_action', e.message, snap);
      if (e instanceof StepError)
        return this.view.escalated('action_failed', e.message, snap);
      throw e;
    }
    return undefined;
  }

  /** Appends the executed step and a history entry saying whether the page changed. */
  private async record(
    acted: Acted,
    by: By,
    op: string,
    before?: PageSnapshot,
  ): Promise<void> {
    if (acted.step !== undefined)
      this.recorded.push(by === 'system2' ? { ...acted.step, by } : acted.step);
    const after = await this.run.snapshot();
    this.history.push({
      op,
      control: acted.control,
      changed: before === undefined || after.fingerprint !== before.fingerprint,
    });
  }

  /** Finishes the run once; a second call returns the first result (#23). */
  private async end(outcome: Outcome): Promise<RunResult> {
    this.ending ??= this.run
      .finish(outcome, this.history.length, { recorded: this.recorded })
      .then((r) => (this.final = r));
    return this.ending;
  }
}
