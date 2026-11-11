import {
  MARK_ATTRIBUTE,
  StepError,
  describeLoc,
  markControl,
  perform,
  recordLoc,
  unique,
  type ActContext,
  type PageSnapshot,
  type Performable,
} from '../browser/index.js';
import {
  ARIA_ROLES,
  FlowError,
  deepExpand,
  untemplateUid,
  type Loc,
  type Step,
} from '../flow/index.js';
import type { RunSession } from '../run/index.js';
import type { ActionGuard } from './guard.js';
import type { Action } from './policy.js';
import type { DirectedStep } from './types.js';

/** The control an action targets no longer exists: the page changed since the snapshot. */
export class StaleControl extends Error {}

/** What one action did: the step to record (none for WAIT) and a label for the history. */
export interface Acted {
  step?: Step;
  control: string;
}

export const SCROLL_PX = 560;
const WAIT_MS = 1000;

/**
 * Runs `build(target)` on control `id` and records it with a replayable locator.
 *
 * @remarks The action runs on the marked element itself (the one System 1 or the orchestrator
 *   chose), while the recorded step carries the locator from {@link recordLoc}. A recorded
 *   locator that is not unique shows up when `saveExploration` replays the recording; heal has no
 *   such replay, so it passes `requireUnique` and the check runs before the action.
 * @param opts.requireUnique resolve the recorded locator first and refuse it unless it matches
 *   exactly one visible element (heal write-back, issue #24).
 * @throws {StaleControl} when the control is gone.
 * @throws {StepError} from recording or performing; `ambiguous` or `not_found` from the
 *   `requireUnique` check.
 */
export async function onControl(
  ctx: ActContext,
  id: number,
  snap: PageSnapshot | undefined,
  build: (target: Loc) => Performable,
  opts: { requireUnique?: boolean } = {},
): Promise<Acted & { loc: Loc }> {
  const token = await markControl(ctx.page, id);
  if (token === undefined) throw new StaleControl(`control ${id} is gone`);
  const loc = await recordLoc(ctx.page, token, {
    testIdAttribute: ctx.exec.testIdAttribute,
    templated: ctx.templated,
  });
  if (opts.requireUnique === true) await unique(ctx.page, loc, ctx.exec);
  const role =
    loc.role ??
    ARIA_ROLES.find((r) => r === snap?.controls.find((c) => c.id === id)?.role);
  await perform(ctx.page, build({ testId: token, role }), ctx.values, {
    ...ctx.exec,
    testIdAttribute: MARK_ATTRIBUTE,
  });
  return { step: build(loc), control: describeLoc(loc), loc };
}

/** Performs a step that names its own target (or needs none). */
export async function performStep(
  ctx: ActContext,
  step: Performable,
): Promise<Acted> {
  await perform(ctx.page, step, ctx.values, ctx.exec);
  return {
    step,
    control: 'target' in step ? describeLoc(step.target) : step.kind,
  };
}

const need = <T>(v: T | undefined): T => {
  if (v === undefined)
    throw new StepError(
      'action_failed',
      'the operation is missing its target or input',
    );
  return v;
};

/**
 * Runs one System 1 operation.
 *
 * @remarks PRESS_ENTER records `press: Enter`, scrolling records `scroll: ±560`, WAIT records
 *   nothing (replay already waits for every locator).
 * @throws {StaleControl} / {StepError} as {@link onControl}; `action_failed` for DONE/BLOCKED.
 * @throws {DestructiveAction} when `guard` refuses a click, a select or an Enter, before the page is touched.
 */
export async function actOp(
  ctx: ActContext,
  a: Action,
  snap: PageSnapshot,
  guard: ActionGuard,
): Promise<Acted> {
  switch (a.op) {
    case 'PRESS_ENTER':
      await guard.checkEnter(ctx.page, 'system1');
      return performStep(ctx, { kind: 'press', key: 'Enter' });
    case 'SCROLL_DOWN':
      return performStep(ctx, { kind: 'scroll', dy: SCROLL_PX });
    case 'SCROLL_UP':
      return performStep(ctx, { kind: 'scroll', dy: -SCROLL_PX });
    case 'WAIT':
      await ctx.page.waitForTimeout(WAIT_MS);
      return { control: 'wait' };
    case 'CLICK':
      guard.check(
        labelOfControl(snap, need(a.control)),
        roleOfControl(snap, need(a.control)),
        'system1',
      );
      return onControl(ctx, need(a.control), snap, (target) => ({
        kind: 'click',
        target,
      }));
    case 'TYPE_TEXT':
    case 'SELECT': {
      const input = need(a.input);
      const kind = a.op === 'TYPE_TEXT' ? 'fill' : 'select';
      if (kind === 'select')
        guard.check(ctx.values[input] ?? '', 'option', 'system1');
      return onControl(ctx, need(a.control), snap, (target) => ({
        kind,
        target,
        input,
      }));
    }
    case 'DONE':
    case 'BLOCKED':
      throw new StepError('action_failed', `${a.op} is not an action`);
  }
}

/** The label System 1 saw for control `id` (its name and test id are not separable in a snapshot). */
const labelOfControl = (snap: PageSnapshot, id: number): string =>
  snap.controls.find((c) => c.id === id)?.name ?? '';

/** The role of control `id` in the snapshot; `undefined` (guarded as an action) when it is not there. */
const roleOfControl = (snap: PageSnapshot, id: number): string | undefined =>
  snap.controls.find((c) => c.id === id)?.role;

/** History label of a step that names its own target (or needs none). */
const labelOf = (s: Step): string =>
  'target' in s
    ? describeLoc(s.target)
    : s.kind === 'as'
      ? `as ${s.profile}${s.goto === undefined ? '' : ` ${s.goto}`}`
      : s.kind === 'goto'
        ? `goto ${s.url}`
        : s.kind;

/**
 * Runs one orchestrator step: a control id from an escalation goes through {@link onControl};
 * any other step goes through {@link RunSession.perform}.
 *
 * @remarks Join a batch with `joinSwitches` first, so `as` followed by `goto` opens that page directly.
 *   A step without a control id has its templates expanded like a replayed step; the recorded step
 *   keeps them, so the saved flow replays with a fresh `{{uid}}`.
 * @throws {StaleControl} / {StepError} as {@link onControl} and `RunSession.perform`.
 * @throws {RunError} from switching profile or navigating.
 * @throws {DestructiveAction} when `guard` refuses a click, check, select or Enter, before the page is touched.
 */
export async function directStep(
  run: RunSession,
  s: DirectedStep,
  guard: ActionGuard,
): Promise<Acted> {
  if ('control' in s) {
    const snap = await run.snapshot();
    if (s.kind === 'click' || s.kind === 'check')
      guard.check(
        labelOfControl(snap, s.control),
        roleOfControl(snap, s.control),
        'system2',
      );
    if (s.kind === 'select')
      guard.check(run.ctx().values[s.input] ?? '', 'option', 'system2');
    if (s.kind === 'fill' || s.kind === 'select') {
      const { kind, input } = s;
      return onControl(run.ctx(), s.control, snap, (target) => ({
        kind,
        target,
        input,
      }));
    }
    const { kind } = s;
    return onControl(run.ctx(), s.control, snap, (target) => ({
      kind,
      target,
    }));
  }
  let expanded: Step;
  try {
    expanded = deepExpand(s, run.templates);
  } catch (e) {
    if (e instanceof FlowError)
      throw new StepError(
        'action_failed',
        `${e.message}; fix the step and send it again`,
      );
    throw e;
  }
  if (expanded.kind === 'click' || expanded.kind === 'check')
    guard.check(
      `${expanded.target.name ?? ''} ${expanded.target.testId ?? ''}`,
      expanded.target.role,
      'system2',
    );
  if (expanded.kind === 'select')
    guard.check(run.ctx().values[expanded.input] ?? '', 'option', 'system2');
  if (expanded.kind === 'press' && expanded.key === 'Enter')
    await guard.checkEnter(run.ctx().page, 'system2');
  await run.perform(expanded);
  return { step: untemplateUid(s, run.templates.uid), control: labelOf(s) };
}
