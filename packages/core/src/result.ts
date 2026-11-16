import type { Assertion } from './flow/index.js';
import type { ErrorKind, ProvenanceStateName } from './foundation/index.js';

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
  /** Demo videos, one per profile (`video-<profile>.webm`), when the run was asked for one (ADR 0032). */
  videos?: string[];
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

/**
 * A record a run (or `flowctl cleanup`) created and could not confirm deleted (ADR 0024 amendment 2026-11-12, s.8):
 * `id: null` for a create whose answer never came, found by its `name`.
 */
export interface Leftover {
  /** The create entry that minted it. */
  entry: string;
  id: string | null;
  name: string | null;
  /**
   * Why it is left: `id_invalid` is an id that no URL of the entry's cleanup templates can carry (not canonical, not
   * of the placeholder's type), as only a ledger file edited outside flowctl holds; nothing was sent for it.
   * `unrecorded` (`flowctl cleanup` only) is an id confirmed deleted whose `cleanup` line could not be written
   * (`writeFailed`): the ledger still lists it, so the next cleanup sends its cleanup again.
   */
  detail:
    | 'create_unconfirmed'
    | 'cleanup_failed'
    | 'verify_failed'
    | 'timeout'
    | 'entry_missing'
    | 'id_invalid'
    | 'unrecorded';
}

/**
 * The end-of-run cleanup of the records a replay on a `shared` env created: how many were confirmed deleted, and
 * what is left. A non-empty `leftover` is `cleanup_incomplete`: the verdict is unchanged, the CLI exits non-zero.
 */
export interface CleanupResult {
  confirmed: number;
  leftover: Leftover[];
  /**
   * `flowctl cleanup` only: the ledger's last line was torn (written in part, as a crash leaves it) and was dropped;
   * every line before it was verified and cleaned. A create whose `id` line was torn shows as `create_unconfirmed`.
   */
  tornTail?: true;
  /** `flowctl cleanup` only: a lock left by a flowctl process that is gone was removed and taken over. */
  staleLock?: true;
  /**
   * `flowctl cleanup` only: the first ledger write that failed (a full disk); no line was written after it, and the
   * ids cleaned after it are leftover (`unrecorded` when they were confirmed deleted).
   */
  writeFailed?: string;
}

/**
 * What System 1 cost one run (T5.5): decisions asked (explore and heal), their round trips, and tokens and cost.
 *
 * @remarks `tokens` and `costUsd` are `unknown` until a driver reports token counts and a price table exists; an
 *   unknown cost is never written as 0 (ADR 0024 section 6).
 */
export interface System1Metrics {
  decisions: number;
  totalMs: number;
  medianMs: number;
  tokens: number | 'unknown';
  costUsd: number | 'unknown';
}

/** The provenance label a run is given: a state and the notes that qualify it (ADR 0020 section h). */
export interface RunProvenance {
  state: ProvenanceStateName;
  notes: string[];
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
  /** Present when the run kept a ledger (a replay on a `shared` env with stored confirmations). */
  cleanup?: CleanupResult;
  weakLocators: string[];
  evidence: EvidenceSummary;
  ms: number;
  /**
   * How the flow's expected values are vouched for (ADR 0020 section h). A label only: it never changes `status`.
   * `unverified` and `unclassified` print as `unverified provenance`.
   */
  provenance: ProvenanceStateName;
  /** Why the label is not stronger or what was not checked (`freshness_not_checked`, `rollback_not_checked`, ...). */
  provenanceNotes: string[];
  /** System 1 decisions of the run; absent when System 1 was not asked (replay without heal). */
  system1?: System1Metrics;
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
