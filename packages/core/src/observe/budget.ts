import { BUDGET_CEILINGS } from '../config/index.js';
import type { LoadedConfig } from '../config.js';
import type { Outcome } from '../run/index.js';

/**
 * What a crawl spent of its budgets (ADR 0024 section 6): navigations against the page budget, the wall-clock budget
 * it ran under, and the cost, `unknown` because a crawl calls no driver. `stoppedBy` names the budget that ended it.
 */
export interface CrawlBudget {
  pages: { used: number; max: number };
  wallClockMs: number;
  costUsd: 'unknown';
  stoppedBy?: 'pages' | 'wallClock';
}

/** The smaller of a repo budget and its built-in ceiling; the ceiling when the repo sets none. */
const capped = (value: number | undefined, ceiling: number): number =>
  Math.min(value ?? ceiling, ceiling);

/**
 * The page budget of one crawl: `target.budgets.pages`, at most the built-in ceiling, counted in navigations (the
 * start page included), so a redirect back to a known page still spends one (ADR 0033 decision 6).
 *
 * @remarks The effective configuration already caps the value; it is capped again here so a config read without the
 *   trust store (a library caller, a test) cannot raise it either.
 */
export class PageBudget {
  readonly max: number;
  private used = 0;
  private stopped = false;

  constructor(private readonly cfg: LoadedConfig) {
    this.max = capped(cfg.target.budgets.pages, BUDGET_CEILINGS.pages);
  }

  /** Spends one navigation; false, and the budget is noted as what stopped the crawl, when none is left. */
  take(): boolean {
    if (this.used >= this.max) {
      this.stopped = true;
      return false;
    }
    this.used++;
    return true;
  }

  /** The report for `outcome`: the wall-clock budget stopped the crawl when the run ended `budget_exceeded`. */
  report(outcome: Outcome): CrawlBudget {
    const timedOut = outcome.error?.kind === 'budget_exceeded';
    const stoppedBy = timedOut
      ? 'wallClock'
      : this.stopped
        ? 'pages'
        : undefined;
    return {
      pages: { used: this.used, max: this.max },
      wallClockMs: capped(
        this.cfg.target.budgets.wallClockMs,
        BUDGET_CEILINGS.wallClockMs,
      ),
      costUsd: 'unknown',
      ...(stoppedBy === undefined ? {} : { stoppedBy }),
    };
  }
}
