import { BUDGET_CEILINGS } from '../config/index.js';
import { RunError } from '../foundation/index.js';
import { toOutcome, type Outcome } from './outcome.js';

/**
 * A run's wall-clock budget (ADR 0024 section 6): an independent timer that, when it fires, aborts {@link signal} and
 * calls `onExpire` (which closes the run's pages so a pending browser call rejects at once). It does not wait for the
 * run to reach its next step.
 *
 * @remarks The run notices through {@link assertWithin}, called wherever it checks its scope, and
 *   {@link overrule} replaces whatever outcome the stopped work produced: a step that failed because its page was
 *   closed is the budget's doing, never the app's. The timer is `unref`'d, so it never keeps the process alive.
 */
export class Deadline {
  private readonly controller = new AbortController();
  private timer: NodeJS.Timeout | undefined;
  private expired: RunError | undefined;

  readonly ms: number;

  /** @param ms the effective `target.budgets.wallClockMs`; the built-in ceiling when the config has none. */
  constructor(ms: number | undefined) {
    this.ms = ms ?? BUDGET_CEILINGS.wallClockMs;
  }

  /** Aborted when the budget runs out; hand it to work that can stop early (the System 1 request). */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Starts the timer once; a second call does nothing.
   *
   * @remarks A rejection of `onExpire` is dropped on purpose: closing the pages is best effort, and the run ends
   *   `budget_exceeded` either way.
   */
  start(onExpire: () => Promise<void>): void {
    if (this.timer !== undefined || this.expired !== undefined) return;
    this.timer = setTimeout(() => {
      this.expired = new RunError(
        'budget_exceeded',
        `The run took longer than its wall-clock budget of ${this.ms} ms and was stopped. Raise target.budgets.wallClockMs (at most 600000) or split the flow.`,
      );
      this.controller.abort(this.expired);
      void onExpire().catch(() => undefined);
    }, this.ms);
    this.timer.unref();
  }

  /** Stops the timer; call when the run finishes. */
  clear(): void {
    clearTimeout(this.timer);
  }

  /** @throws {RunError} `budget_exceeded` once the budget ran out. */
  assertWithin(): void {
    if (this.expired !== undefined) throw this.expired;
  }

  /**
   * The run's outcome once the budget ran out: `error: budget_exceeded`, unless the run already ended on a scope or
   * destructive-request refusal, which stays (a security stop outranks a timeout). Before that, `outcome` as is.
   */
  overrule(outcome: Outcome): Outcome {
    if (this.expired === undefined) return outcome;
    const kind = outcome.error?.kind;
    if (kind === 'scope_violation' || kind === 'destructive_blocked')
      return outcome;
    return toOutcome(this.expired);
  }
}
