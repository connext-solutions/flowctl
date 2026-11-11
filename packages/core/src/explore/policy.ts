import type { Decision, HistoryEntry, Op } from '../system1/index.js';
import type { EscalationReason } from './types.js';

export const LOOP_REPEATS = 3;
export const DONE_REJECTIONS = 3;

export interface Action {
  op: Op;
  control?: number;
  input?: string;
}

export type Choice =
  | { kind: 'act'; action: Action }
  | { kind: 'escalate'; reason: EscalationReason; detail: string };

const escalate = (reason: EscalationReason, detail: string): Choice => ({
  kind: 'escalate',
  reason,
  detail,
});

/** True when the last {@link LOOP_REPEATS} actions were the same non-WAIT operation on the same control and none changed the page. */
export function isLoop(history: HistoryEntry[]): boolean {
  const last = history.slice(-LOOP_REPEATS);
  const first = last[0];
  return (
    last.length === LOOP_REPEATS &&
    first !== undefined &&
    first.op !== 'WAIT' &&
    last.every(
      (h) => !h.changed && h.op === first.op && h.control === first.control,
    )
  );
}

/**
 * Turns a System 1 decision into the action to run, or an escalation.
 *
 * @param afterDone the top answer was a DONE that the assertions rejected: take the most likely
 *   other executable operation without the threshold on the operation (a runner-up is never confident), but its
 *   target and input must still meet the threshold, so a rejected DONE never turns a 4% guess at a control into a
 *   click (issue #42).
 * @remarks BLOCKED escalates; an operation, target or input below `threshold` escalates
 *   `low_confidence`, and so does a missing target or input answer.
 */
export function choose(
  d: Decision,
  threshold: number,
  afterDone: boolean,
): Choice {
  const pick = afterDone
    ? d.ranked.find((r) => r.op !== 'DONE' && r.op !== 'BLOCKED')
    : d.ranked[0];
  if (pick === undefined)
    return escalate(
      afterDone ? 'done_rejected' : 'BLOCKED',
      'no executable operation was offered',
    );
  if (pick.op === 'BLOCKED')
    return escalate('BLOCKED', 'System 1 answered BLOCKED');
  const confident = (p: number): boolean => p >= threshold;
  if (!afterDone && !confident(pick.p))
    return escalate('low_confidence', `${pick.op} p=${pick.p.toFixed(2)}`);
  if (pick.op !== 'CLICK' && pick.op !== 'TYPE_TEXT' && pick.op !== 'SELECT')
    return { kind: 'act', action: { op: pick.op } };
  const target = d.targets[pick.op];
  if (target === undefined || !confident(target.p))
    return escalate(
      'low_confidence',
      `${pick.op} target ${target === undefined ? 'missing' : `p=${target.p.toFixed(2)}`}`,
    );
  if (pick.op === 'CLICK')
    return { kind: 'act', action: { op: pick.op, control: target.id } };
  const input = d.input;
  if (input === undefined || !confident(input.p))
    return escalate(
      'low_confidence',
      `${pick.op} input ${input === undefined ? 'missing' : `p=${input.p.toFixed(2)}`}`,
    );
  return {
    kind: 'act',
    action: { op: pick.op, control: target.id, input: input.key },
  };
}
