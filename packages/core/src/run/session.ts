import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import {
  perform,
  takeSnapshot,
  type ActContext,
  type PageSnapshot,
} from '../browser/index.js';
import {
  resolveEnv,
  runsPath,
  type LoadedConfig,
  type ResolvedEnv,
} from '../config.js';
import {
  type Assertion,
  type Flow,
  type Step,
  type TemplateContext,
} from '../flow/index.js';
import type { RunResult } from '../result.js';
import { Deadline } from './deadline.js';
import { Evidence } from './evidence.js';
import { prepareHooks, runHookKind, type StoreChoice } from './hooks.js';
import { checkEnvInputs } from './env-inputs.js';
import { RunError, type Outcome } from './outcome.js';
import { finishRun } from './finish.js';
import { Profiles } from './profiles.js';
import { guardFor, type ScopeGuard } from './scope-guard.js';
import { prepareRun, type Prepared } from './prepare.js';
import type { HookSession } from '../trust/index.js';
import { verify, type Verdict } from './verifier.js';
import type { RunSessionOptions } from './options.js';

/**
 * Drives one browser run of one flow: a run directory with evidence, one browser context per
 * profile, setup/teardown hooks, performing steps, snapshots and assertion checks on the active
 * page, and the final {@link RunResult}. Replay and exploration only decide which steps to perform.
 *
 * @example
 * const run = RunSession.open(cfg, flow, { browser }); // never fails the run
 * try {
 *   await run.begin(); // may throw RunError / FlowError
 *   for (const step of run.steps) await run.perform(step); // StepError on a broken step
 *   outcome = outcomeOf(await run.check());
 * } catch (e) {
 *   outcome = toOutcome(e);
 * }
 * return run.finish(outcome, stepsDone); // always call, also after a failed begin
 * @see docs/adr/0010-assertion-semantics.md
 */
export class RunSession {
  readonly runId: string;
  readonly evidence: Evidence;
  private readonly started = Date.now();
  private readonly profiles: Profiles;
  private prepared: Prepared | undefined;
  private setupStarted = false;
  private hooks: HookSession | undefined;
  private guard: ScopeGuard | undefined;
  private readonly store: StoreChoice;
  private readonly deadline: Deadline;

  private constructor(
    private readonly cfg: LoadedConfig,
    private readonly flow: Flow,
    readonly env: ResolvedEnv,
    private readonly opts: RunSessionOptions,
  ) {
    this.runId = `r_${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
    this.store = opts.store ?? 'default';
    this.evidence = new Evidence(
      runsPath(cfg),
      this.runId,
      cfg.runsRetention,
      cfg.flowsPath,
      opts.trace,
    );
    this.profiles = new Profiles(cfg, env, opts.browser, this.evidence);
    this.deadline = new Deadline(cfg.target.budgets.wallClockMs);
  }

  /**
   * Aborted when the wall-clock budget, started by {@link begin}, runs out (ADR 0024 section 6): the pages are then
   * closed and the run ends `error: budget_exceeded` at its next step or check. Pass it to System 1 calls.
   */
  get signal(): AbortSignal {
    return this.deadline.signal;
  }

  /** Creates the run directory and evidence; touches neither browser nor app. @throws {ConfigError} unknown env. */
  static open(
    cfg: LoadedConfig,
    flow: Flow,
    opts: RunSessionOptions,
  ): RunSession {
    return new RunSession(cfg, flow, resolveEnv(cfg, opts.env), opts);
  }

  /**
   * Resolves inputs and templates, runs the setup hook, then opens the flow's profile at its
   * start page.
   *
   * @throws {RunError} `hooks_untrusted`, `env_not_allowed` or `scope_violation` (before anything runs),
   *   `setup_failed`, `profile_expired` or `app_unreachable`.
   * @throws {FlowError} when an `{ env }` input is not set.
   * @see docs/adr/0021-hook-consent.md
   */
  async begin(): Promise<void> {
    this.deadline.start(() => this.profiles.closePages());
    this.guard = guardFor(this.cfg, this.env, this.store, this.opts.writes);
    this.profiles.useGuard(this.guard);
    this.hooks = prepareHooks(this.cfg, this.flow, this.store);
    const inputs = checkEnvInputs(this.flow, this.store);
    this.prepared = prepareRun({ ...this.flow, inputs }, this.env);
    this.evidence.useSecrets(this.prepared.secrets);
    if (this.flow.setup !== undefined) {
      if (this.hooks === undefined)
        throw new RunError('internal', 'setup has no consented hook session');
      const hook = await runHookKind(this.hooks, 'setup', this.cfg, () => {
        this.setupStarted = true;
      });
      if (!hook.ok) throw new RunError('setup_failed', hook.output);
    }
    await this.profiles.switchTo(
      this.flow.profile,
      undefined,
      this.ready().start,
    );
  }

  /** Input values with templates expanded. Available after {@link begin}. */
  get values(): Record<string, string> {
    return this.ready().values;
  }

  /** The run's template values (`{{uid}}`, today). Available after {@link begin}. */
  get templates(): TemplateContext {
    return this.ready().templates;
  }

  /** Resolved values of `{ env }` inputs: never sent to a model. Available after {@link begin}. */
  get secrets(): string[] {
    return this.ready().secrets;
  }

  /** Steps with templates expanded. Available after {@link begin}. */
  get steps(): Step[] {
    return this.ready().steps;
  }

  /** Assertions with templates expanded. Available after {@link begin}. */
  get assertions(): Assertion[] {
    return this.ready().assertions;
  }

  /** Page of the active profile. @throws {Error} before {@link begin} has opened a profile. */
  get page(): Page {
    return this.profiles.page;
  }

  /** What an action needs on the active page: page, input values, timeouts, templated values. */
  ctx(): ActContext {
    return {
      page: this.page,
      values: this.values,
      exec: {
        testIdAttribute: this.cfg.testIdAttribute,
        timeout: this.cfg.stepTimeout,
        flowsRoot: this.cfg.flowsPath,
        secrets: this.ready().secrets,
      },
      templated: this.ready().templated,
    };
  }

  /**
   * Performs one step on the run: `as` switches profile (opening its `goto` page, or the start page
   * for a new context), `goto` navigates, anything else runs on the active page.
   *
   * @throws {StepError} when an action cannot run (target not found or ambiguous, action failed).
   * @throws {RunError} `profile_expired` / `app_unreachable` from switching or navigating; `scope_violation` when
   *   the step (or anything the page did meanwhile) reached outside the run's scope, also in place of the step's own
   *   error.
   */
  async perform(step: Step): Promise<void> {
    try {
      if (step.kind === 'as')
        await this.profiles.switchTo(
          step.profile,
          step.goto,
          this.ready().start,
        );
      else if (step.kind === 'goto') await this.profiles.goto(step.url);
      else {
        const c = this.ctx();
        await perform(c.page, step, c.values, c.exec);
      }
    } catch (e) {
      this.assertInScope();
      throw e;
    }
    this.assertInScope();
  }

  /**
   * Ends the run's work when it left its scope: a step that failed because a request was blocked is the scope's
   * fault, not the app's, so it must never read as a `failed` verdict (ADR 0024 section 3).
   *
   * @throws {RunError} `scope_violation` naming the first request or page out of scope; `internal` when the scope
   *   guard could not watch a page's redirects; `app_unreachable` when a popup's first answer could not be fetched;
   *   `budget_exceeded` once the wall-clock budget ran out.
   */
  assertInScope(): void {
    this.guard?.assertClean();
    this.deadline.assertWithin();
  }

  /** Visible controls and text of the active page, without `snapshotIgnore` and dev overlays. */
  snapshot(): Promise<PageSnapshot> {
    return takeSnapshot(
      this.page,
      this.cfg.snapshotIgnore,
      this.cfg.stepTimeout,
    );
  }

  /**
   * The assertions' verdict on the run so far, waiting up to `timeoutMs` (0 = check once).
   *
   * @throws {RunError} `scope_violation` when the run left its scope, before or while the assertions were checked: a
   *   verdict never stands on a run that reached what it may not.
   */
  async check(timeoutMs: number = this.cfg.assertTimeout): Promise<Verdict> {
    this.assertInScope();
    const verdict = await verify(
      this.assertions,
      {
        page: this.page,
        evidence: this.evidence,
        testIdAttribute: this.cfg.testIdAttribute,
        origins: this.guard?.origins,
      },
      timeoutMs,
    );
    this.assertInScope();
    return verdict;
  }

  /**
   * Ends the run: collects evidence, closes every context, runs the teardown hook, writes
   * `run.json` and prunes old run directories.
   *
   * @remarks Always call it, including after a failed {@link begin}; it never rejects. A run that left its scope
   *   ends `error: scope_violation` (one whose write the request layer stopped, `destructive_blocked`) whatever
   *   outcome the caller passes, unless that outcome is already an error, so
   *   no path (a failed step, an escalation, a heal) can report a verdict on such a run. Each stage
   *   runs even when an earlier one failed; a failed stage turns a non-error outcome into
   *   `error: internal` naming the stage. Teardown runs only for a run that started: its setup hook
   *   was started (even if it failed), or it has no setup and got past input resolution. A failing
   *   teardown sets `teardownFailed` instead of changing the outcome.
   * @param extra healed step indices and, for an exploration, the recorded steps whose weak
   *   locators are reported.
   */
  async finish(
    outcome: Outcome,
    stepsDone: number,
    extra: Parameters<typeof finishRun>[3] = {},
  ): Promise<RunResult> {
    this.deadline.clear();
    const final = this.deadline.overrule(
      this.guard?.overrule(outcome) ?? outcome,
    );
    return finishRun(
      {
        cfg: this.cfg,
        flow: this.flow,
        env: this.env,
        runId: this.runId,
        started: this.started,
        evidence: this.evidence,
        profiles: this.profiles,
        setupStarted: this.setupStarted,
        prepared: this.prepared !== undefined,
        hooks: this.hooks,
        secrets: this.prepared?.secrets ?? [],
      },
      final,
      stepsDone,
      extra,
    );
  }

  private ready(): Prepared {
    if (this.prepared === undefined) {
      throw new RunError('internal', 'RunSession.begin() has not completed');
    }
    return this.prepared;
  }
}
