import type { System1Metrics } from '../result.js';
import type { DecisionLogEntry } from './decision-log.js';

/** The middle value of `values`, the mean of the two middle ones for an even count, rounded to a millisecond. */
const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const value =
    sorted.length % 2 === 1
      ? (sorted[mid] ?? 0)
      : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return Math.round(value);
};

/**
 * The System 1 cost and time of one run, from its `decisions.jsonl` entries (explore and heal).
 *
 * @remarks No driver reports token counts yet, and flowctl has no price table, so `tokens` and `costUsd` are
 *   `unknown`: a cost the run cannot compute is never written as 0 (ADR 0024 section 6).
 * @returns `undefined` when System 1 was not asked, so a model-free replay keeps its `run.json` as it was.
 */
export function system1Metrics(
  entries: readonly DecisionLogEntry[],
): System1Metrics | undefined {
  if (entries.length === 0) return undefined;
  const ms = entries.map((e) => e.ms);
  return {
    decisions: entries.length,
    totalMs: ms.reduce((a, b) => a + b, 0),
    medianMs: median(ms),
    tokens: 'unknown',
    costUsd: 'unknown',
  };
}
