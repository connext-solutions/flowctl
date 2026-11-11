import type { Assertion } from './flow/index.js';
import type { ErrorKind } from './foundation/index.js';

export type { ErrorKind } from './foundation/index.js';

export type RunStatus = 'passed' | 'failed' | 'error';

export interface StepFailure {
  /** Index in the flow's normalised steps; a profile switch with its page (`as` + `goto`) is one step. */
  step: number;
  kind: 'not_found' | 'ambiguous' | 'action_failed';
  message: string;
}

export interface AssertionFailure {
  assertion: Assertion;
  got: string;
}

export interface EvidenceSummary {
  dir: string;
  traces: string[];
  screenshot?: string;
  /** Failed fetch/xhr calls only: `<status> <METHOD> <url> <body snippet>`, credentials and secrets as `***`. */
  network: string[];
  console: string[];
  /**
   * What the traces hold (ADR 0030): `safe` (actions, timings, URLs, console; no DOM, headers or bodies; the
   * default) or `full` (DOM snapshots and screenshots, with cookies and bodies: do not share).
   */
  trace?: TraceMode;
}

/** How much a run's Playwright trace records (ADR 0030). */
export type TraceMode = 'safe' | 'full';

/** A locator `--heal` found for a broken step: `from` and `to` as `describeLoc` prints them. */
export interface HealProposal {
  step: number;
  from: string;
  to: string;
  /** The flow file now has `to`: the run passed and the caller confirmed (`--accept-heals`). */
  written: boolean;
}

export interface RunResult {
  runId: string;
  flow: string;
  env: string;
  status: RunStatus;
  failed?: StepFailure | AssertionFailure;
  error?: { kind: ErrorKind; hint: string };
  /** Steps executed, counted as normalised steps (a profile switch with its page is one). */
  steps: number;
  /** Indices (normalised steps, as in {@link StepFailure.step}) whose locator was healed. */
  healed: number[];
  /**
   * For each healed step, the locator it had and the one System 1 found, and whether the flow file was updated
   * (only when the caller confirmed it, ADR 0008 amendment, issue #48). Absent when nothing was healed.
   */
  heals?: HealProposal[];
  teardownFailed: boolean;
  weakLocators: string[];
  evidence: EvidenceSummary;
  ms: number;
}

export interface FlowSummary {
  flow: string;
  runs: number;
  statuses: RunStatus[];
  flaky: boolean;
}

export interface ReplaySummary {
  results: RunResult[];
  flows: FlowSummary[];
  passed: number;
  failed: number;
  flaky: number;
  errors: number;
}
