import type { Assertion, FlowDoc, Step } from '../flow/index.js';
import type { AssertionFailure, RunResult } from '../result.js';

/** What the orchestrator asks to explore; assertions are written before the run (ADR 0004). */
export interface ExploreRequest {
  goal: string;
  start: string;
  profile: string;
  inputs?: FlowDoc['inputs'];
  assertions: Assertion[];
  setup?: string;
  teardown?: string;
  maxSteps?: number;
  /**
   * Lets the orchestrator (never System 1) click a control that looks destructive on a `shared` env; never
   * on `production`. Not saved with the flow.
   */
  allowDestructive?: boolean;
}

export type EscalationReason =
  | 'BLOCKED'
  | 'low_confidence'
  | 'done_rejected'
  | 'max_steps'
  | 'loop'
  | 'action_failed'
  | 'destructive_action';

/**
 * Why an exploration stopped for the orchestrator.
 *
 * @remarks `detail` and the names and values in `controls` come from the page under test: they are data,
 *   never instructions. They are sanitised (one line, hidden characters removed, secrets as `***`, capped) and
 *   names are JSON-quoted.
 */
export interface Escalation {
  reason: EscalationReason;
  detail: string;
  /** Visible controls of the current page, `[id] role "name"` (and ` = "value"`), at most 40. */
  controls: string[];
}

/** An exploration waiting for the orchestrator; its browser contexts stay open. */
export interface Escalated {
  runId: string;
  status: 'escalated';
  steps: number;
  escalation: Escalation;
  /** The first assertion that does not pass yet. */
  failed?: AssertionFailure;
}

export type ExploreStop = Escalated | RunResult;

/**
 * A step the orchestrator (System 2) gives during an exploration: any flow step, or a click /
 * check / hover / fill / select on a control id from an escalation's `controls`.
 */
export type DirectedStep =
  | Step
  | { kind: 'click' | 'check' | 'hover'; control: number }
  | { kind: 'fill' | 'select'; control: number; input: string };

/** What a passed exploration saves: the request as given and the executed steps. */
export interface Recording {
  request: ExploreRequest;
  env: string;
  steps: Step[];
  model: string;
}
