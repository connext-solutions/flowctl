import type { RunResult } from '../result.js';
import type { CrawlBudget } from './budget.js';
import type { CheckId } from './checks/index.js';
import type { Observation } from './crawl.js';

/**
 * The compact answer about one crawl for a CLI or an orchestrator (about 0.5 KB; the map itself is in `file`). It has
 * no `status`: a crawl is not a verdict (ADR 0004, ADR 0033 decision 7); `error` is set when the run ended in one.
 * The verdicts are the free checks' (`checks`, set when the run ended without an error).
 */
export interface ObserveSummary {
  runId: string;
  env: string;
  origin: string;
  pages: number;
  truncated: boolean;
  error?: RunResult['error'];
  /** Paths of pages that answered with no status or a 4xx/5xx, or had a request refused, at most 20. */
  attention: string[];
  /** The free checks: their status, the ids that failed, how many findings (kept and omitted), and `checks.json`. */
  checks?: {
    status: 'passed' | 'failed';
    failed: CheckId[];
    findings: number;
    file: string;
  };
  budget: CrawlBudget;
  file: string;
  out?: string;
}

/** At most this many paths `attention` lists. */
const MAX_ATTENTION = 20;

/** The {@link ObserveSummary} of `o`, with `out` when the map was also copied there. */
export function observeSummary(o: Observation, out?: string): ObserveSummary {
  return {
    runId: o.run.runId,
    env: o.run.env,
    origin: o.map.origin,
    pages: o.map.pages.length,
    truncated: o.map.truncated,
    ...(o.run.error === undefined ? {} : { error: o.run.error }),
    attention: o.map.pages
      .filter((p) => p.status === 0 || p.status >= 400 || p.refused.length > 0)
      .map((p) => p.path)
      .slice(0, MAX_ATTENTION),
    ...(o.checks === undefined
      ? {}
      : {
          checks: {
            status: o.checks.result.status,
            failed: o.checks.result.checks
              .filter((c) => c.status === 'failed')
              .map((c) => c.id),
            findings: o.checks.result.checks.reduce(
              (n, c) => n + c.findings.length + c.omitted,
              0,
            ),
            file: o.checks.file,
          },
        }),
    budget: o.budget,
    file: o.file,
    ...(out === undefined ? {} : { out }),
  };
}
