import { describeLoc, destructiveWord, StepError } from '../browser/index.js';
import type { Loc, Step } from '../flow/index.js';
import type { RunSession } from '../run/index.js';
import {
  assertDriverFor,
  type CheckedDriver,
  type TargetOp,
} from '../system1/index.js';
import { StaleControl, onControl } from './act.js';
import { decisionEntry, describeAction } from './decisions.js';

const HEAL_OPS: Partial<Record<Step['kind'], TargetOp>> = {
  click: 'CLICK',
  check: 'CLICK',
  hover: 'CLICK',
  fill: 'TYPE_TEXT',
  select: 'SELECT',
};

export interface HealOptions {
  goal: string;
  system1: CheckedDriver;
  threshold: number;
}

/**
 * Asks System 1 once which element a broken step meant, runs the step there, and returns the
 * element's locator.
 *
 * @param index the step's index in the flow, logged with the decision in `decisions.jsonl`.
 * @returns The new locator, or `undefined` when the step kind cannot heal (as, goto, press,
 *   upload, drag…), System 1 is not confident, it chose a control whose name looks destructive (delete, approve,
 *   Xoá, Duyệt…) for a step whose own name does not (page text can steer the choice, issue #48), the element
 *   vanished, or its recorded locator does not match exactly one visible element (nothing is written back,
 *   issue #24); the step then fails as in strict replay.
 * @throws {RunError} `system1_unreachable` from the driver; `system1_not_allowed` when the driver was not made by
 *   `createDriver` for the run's env (`assertDriverFor`).
 * @see docs/adr/0008-strict-model-free-replay.md
 */
export async function healStep(
  run: RunSession,
  step: Step,
  index: number,
  o: HealOptions,
): Promise<Loc | undefined> {
  if (!('target' in step)) return undefined;
  const op = HEAL_OPS[step.kind];
  if (op === undefined) return undefined;
  assertDriverFor(o.system1, run.env.name);
  const snap = await run.snapshot();
  const asked = Date.now();
  const d = await o.system1.decide(
    {
      goal: `${o.goal}\nThe next recorded step is: ${step.kind} ${describeLoc(step.target)}. Choose the element it meant.`,
      page: snap,
      history: [],
      ops: [op, 'BLOCKED'],
      inputs: [],
      secrets: run.secrets,
    },
    run.signal,
  );
  const top = d.ranked[0];
  const target = d.targets[op];
  const chosen =
    target === undefined
      ? undefined
      : snap.controls.find((c) => c.id === target.id);
  const steered =
    chosen !== undefined &&
    destructiveWord(chosen.name) !== undefined &&
    destructiveWord(step.target.name ?? '') === undefined;
  const confident =
    top?.op === op &&
    target !== undefined &&
    top.p >= o.threshold &&
    target.p >= o.threshold &&
    !steered;
  run.evidence.decided(
    decisionEntry({
      source: 'heal',
      step: index,
      url: snap.url,
      ms: Date.now() - asked,
      outcome: confident
        ? `heal step ${index} with ${describeAction({ op, control: target.id }, snap)}`
        : steered
          ? `no heal: System 1 chose a control that looks destructive for a step that is not`
          : `no heal: ${top?.op ?? 'no answer'} below threshold ${o.threshold} or not ${op}`,
      decision: d,
      snap,
      secrets: run.secrets,
    }),
  );
  if (!confident) return undefined;
  try {
    return (
      await onControl(
        run.ctx(),
        target.id,
        snap,
        (t) => ({ ...step, target: t }),
        { requireUnique: true },
      )
    ).loc;
  } catch (e) {
    if (e instanceof StaleControl || e instanceof StepError) return undefined;
    throw e;
  }
}
