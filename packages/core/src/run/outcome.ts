import { FlowError, RunError } from '../foundation/index.js';
import type { RunResult } from '../result.js';
import type { Verdict } from './verifier.js';

export { RunError } from '../foundation/index.js';

/** The verdict part of a {@link RunResult}, decided before the run is finished. */
export type Outcome = Pick<RunResult, 'status' | 'failed' | 'error'>;

/** The outcome the assertions decide: `passed`, or `failed` with the first failing assertion. */
export const outcomeOf = (v: Verdict): Outcome =>
  v.passed ? { status: 'passed' } : { status: 'failed', failed: v.failed };

/** The message of an Error, or the stringified value for anything else thrown. */
export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Turns anything thrown while running into an `error` outcome.
 *
 * @returns `RunError` → its kind; `FlowError` → `flow_invalid`; anything else → `internal`.
 */
export function toOutcome(e: unknown): Outcome {
  if (e instanceof RunError) {
    return { status: 'error', error: { kind: e.kind, hint: e.hint } };
  }
  if (e instanceof FlowError) {
    return {
      status: 'error',
      error: { kind: 'flow_invalid', hint: e.message },
    };
  }
  return {
    status: 'error',
    error: { kind: 'internal', hint: errorMessage(e) },
  };
}
