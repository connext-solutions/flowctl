import type { PageSnapshot } from '../browser/index.js';
import type { LoadedConfig } from '../config.js';
import type { RunResult } from '../result.js';
import {
  RunError,
  isOnce,
  type Outcome,
  type RunSession,
  type Verdict,
} from '../run/index.js';
import {
  assertDriverFor,
  type CheckedDriver,
  type HistoryEntry,
} from '../system1/index.js';
import { describeAction } from './decisions.js';
import {
  DONE_REJECTIONS,
  LOOP_REPEATS,
  choose,
  isLoop,
  type Action,
} from './policy.js';
import { inputChoices, opsFor } from './request.js';
import type { RunView } from './run-view.js';
import type { Escalated, ExploreRequest, ExploreStop } from './types.js';

/** Operations that never count as acting, even when the page changed under them (a clock, a toast fading out). */
const IDLE_OPS = new Set([
  'WAIT',
  'SCROLL_DOWN',
  'SCROLL_UP',
  'wait',
  'scroll',
]);

/**
 * Whether the exploration has acted: an action other than waiting or scrolling ran on a live control, by System 1 or
 * the orchestrator. Until then no verdict may pass: assertions that already hold on arrival prove nothing about the
 * goal (issue #47, ADR 0010 amendment).
 *
 * @remarks Whether the page changed is not required: the snapshot fingerprint covers controls, not text, so a click
 *   that only shows a message would not count. An action that does nothing still counts; hold `text` to its region
 *   (`within`) where page content could already contain it.
 */
export const hasActed = (history: readonly HistoryEntry[]): boolean =>
  history.some((h) => h.control !== 'stale' && !IDLE_OPS.has(h.op));

/** Why a verdict before {@link hasActed} is refused; shown as the failing assertion's `got`. */
export const NOTHING_DONE =
  'no action (other than waiting or scrolling) has run yet, so nothing was verified';

/** Mutable counters the loop shares with its `Exploration`. */
export interface LoopState {
  rejectedDone: number;
  model: string;
}

/** What {@link runLoop} needs from an `Exploration`. */
export interface LoopDeps {
  cfg: LoadedConfig;
  req: ExploreRequest;
  run: RunSession;
  system1: CheckedDriver | undefined;
  view: RunView;
  history: HistoryEntry[];
  goal: string;
  state: LoopState;
  act: (a: Action, snap: PageSnapshot) => Promise<Escalated | undefined>;
  end: (outcome: Outcome) => Promise<RunResult>;
}

/**
 * The decision loop of `Exploration.advance`: snapshot, ask System 1, verify DONE against the
 * assertions, act or escalate, until the run passes or escalates.
 *
 * @throws {RunError} `system1_not_allowed` when no System 1 client was created; `scope_violation` at the next
 *   decision after an action reached outside the run's scope, so System 1 is never asked again on such a run.
 * @see docs/adr/0019-exploration-loop.md
 */
export async function runLoop(d: LoopDeps): Promise<ExploreStop> {
  const { cfg, req, run, system1, view, history, state } = d;
  if (system1 === undefined)
    throw new RunError('system1_not_allowed', 'System 1 is not available');
  assertDriverFor(system1, run.env.name);
  const maxSteps = req.maxSteps ?? cfg.maxSteps;
  const threshold = cfg.system1?.confidenceThreshold ?? 0.5;
  const early = run.assertions.some((a) => !isOnce(a));
  const inputs = req.inputs ?? {};
  for (;;) {
    run.assertInScope();
    const acted = hasActed(history);
    if (early && acted && (await run.check(0)).passed)
      return d.end({ status: 'passed' });
    const snap = await run.snapshot();
    if (history.length >= maxSteps)
      return view.escalated(
        'max_steps',
        `stopped after ${maxSteps} actions`,
        snap,
      );
    const asked = Date.now();
    const decision = await system1.decide(
      {
        goal: d.goal,
        page: snap,
        history,
        ops: opsFor(snap, Object.keys(inputs).length > 0),
        inputs: inputChoices(inputs, run.values),
        secrets: run.secrets,
      },
      run.signal,
    );
    state.model = decision.model;
    const log = (outcome: string): void =>
      view.decided(snap, decision, Date.now() - asked, outcome);
    const done = decision.ranked[0]?.op === 'DONE';
    let note = '';
    if (done) {
      const first = run.assertions[0];
      const v: Verdict = acted
        ? await run.check()
        : {
            passed: false,
            failed:
              first === undefined
                ? undefined
                : { assertion: first, got: NOTHING_DONE },
          };
      if (v.passed) {
        log('DONE accepted: assertions pass');
        return d.end({ status: 'passed' });
      }
      state.rejectedDone += 1;
      note = ` after DONE rejected ${state.rejectedDone}/${DONE_REJECTIONS}`;
      if (state.rejectedDone >= DONE_REJECTIONS) {
        log(`escalate done_rejected${note}`);
        return view.escalated(
          'done_rejected',
          acted
            ? `System 1 said DONE ${DONE_REJECTIONS} times in a row but the assertions do not pass`
            : `System 1 said DONE ${DONE_REJECTIONS} times before taking any action other than waiting or scrolling; a run passes only after it acted`,
          snap,
          v.failed,
        );
      }
    } else {
      state.rejectedDone = 0;
    }
    const c = choose(decision, threshold, done);
    log(
      c.kind === 'escalate'
        ? `escalate ${c.reason}: ${c.detail}${note}`
        : `act ${describeAction(c.action, snap)}${note}`,
    );
    if (c.kind === 'escalate') return view.escalated(c.reason, c.detail, snap);
    const stop = await d.act(c.action, snap);
    if (stop !== undefined) return stop;
    if (isLoop(history))
      return view.escalated(
        'loop',
        `${LOOP_REPEATS} identical actions did not change the page`,
      );
  }
}
