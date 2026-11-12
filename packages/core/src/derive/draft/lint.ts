import { NAME_PATTERN } from '../../foundation/index.js';
import type { AppMap } from '../../observe/index.js';
import { normText, refusal } from '../../spec/index.js';
import { elementAt } from './pointer.js';
import {
  ACTION_ROLES,
  DRAFT_ACTIONS,
  type DraftAction,
  type DraftTarget,
  NAV_ROLES,
} from './types.js';

/**
 * A step as the lint reads it: a {@link DraftStep}, or one edited by hand or read from a file, so `action` may be any
 * string.
 */
export interface LintStep {
  n: number;
  actor: string;
  action: string;
  target?: DraftTarget;
  input?: string;
  via?: readonly string[];
  page?: string;
}

/**
 * What the step lint reports (the mechanical part of the team step template):
 * - `numbering`: the step's number is not its position (1, 2, 3, …);
 * - `no_actor`: no one acts (empty actor, or one the Unicode rules refuse);
 * - `observe_only`: the step only looks; that belongs to the case's Expected;
 * - `unknown_action`: an action that is not one of {@link DRAFT_ACTIONS};
 * - `missing_target`: an action with no quoted label (no control, an empty name, an `open` with no page or menu path);
 * - `ungrounded_target`: the control is not in the map at its pointer with that role and name;
 * - `role_mismatch`: the control's role cannot take the action;
 * - `ungrounded_via`: a menu path label is no navigation control of the map;
 * - `ungrounded_page`: the page is not in the map;
 * - `input_literal`: the input is not a reference (a flow name such as `input-1`), so it may be a value;
 * - `missing_input`: a `fill` or `select` with no input;
 * - `unexpected_input`: an input on an action that takes none;
 * - `duplicate_step`: the same actor, action, target, input, menu path and page as the step before it.
 */
export type LintKind =
  | 'numbering'
  | 'no_actor'
  | 'observe_only'
  | 'unknown_action'
  | 'missing_target'
  | 'ungrounded_target'
  | 'role_mismatch'
  | 'ungrounded_via'
  | 'ungrounded_page'
  | 'input_literal'
  | 'missing_input'
  | 'unexpected_input'
  | 'duplicate_step';

/** One problem: its kind and the index of the step in the list. */
export interface LintProblem {
  kind: LintKind;
  step: number;
}

const isAction = (a: string): a is DraftAction =>
  DRAFT_ACTIONS.some((x) => x === a);

const navNames = (map: AppMap): Set<string> =>
  new Set(
    map.pages.flatMap((p) =>
      p.controls
        .filter((c) => NAV_ROLES.includes(c.role))
        .map((c) => normText(c.name)),
    ),
  );

const sameAs = (a: LintStep, b: LintStep | undefined): boolean =>
  b !== undefined &&
  JSON.stringify([a.actor, a.action, a.target, a.input, a.via, a.page]) ===
    JSON.stringify([b.actor, b.action, b.target, b.input, b.via, b.page]);

/** The target and page problems of an action step. */
function targetProblems(
  s: LintStep,
  action: DraftAction,
  map: AppMap,
  nav: Set<string>,
): LintKind[] {
  if (action === 'open') {
    const out: LintKind[] = [];
    if (s.page === undefined && (s.via ?? []).length === 0)
      out.push('missing_target');
    if ((s.via ?? []).some((v) => !nav.has(normText(v))))
      out.push('ungrounded_via');
    if (s.page !== undefined && !map.pages.some((p) => p.path === s.page))
      out.push('ungrounded_page');
    return out;
  }
  const t = s.target;
  if (t === undefined || normText(t.name) === '') return ['missing_target'];
  const at = elementAt(map, t.pointer);
  if (at?.role !== t.role || at.name !== t.name) return ['ungrounded_target'];
  return ACTION_ROLES[action].includes(t.role) ? [] : ['role_mismatch'];
}

/** The input problems of an action step: `fill` and `select` take one reference, the others none. */
function inputProblems(s: LintStep, action: DraftAction): LintKind[] {
  const takes = action === 'fill' || action === 'select';
  if (!takes) return s.input === undefined ? [] : ['unexpected_input'];
  if (s.input === undefined) return ['missing_input'];
  return NAME_PATTERN.test(s.input) ? [] : ['input_literal'];
}

/** The problems of one step, in the order of {@link LintKind}. */
function stepProblems(
  s: LintStep,
  i: number,
  prev: LintStep | undefined,
  map: AppMap,
  nav: Set<string>,
): LintKind[] {
  const out: LintKind[] = [];
  if (s.n !== i + 1) out.push('numbering');
  const actor = normText(s.actor);
  if (actor === '' || refusal(actor) !== null) out.push('no_actor');
  if (s.action === 'observe') return [...out, 'observe_only'];
  if (!isAction(s.action)) return [...out, 'unknown_action'];
  out.push(...targetProblems(s, s.action, map, nav));
  out.push(...inputProblems(s, s.action));
  if (sameAs(s, prev)) out.push('duplicate_step');
  return out;
}

/**
 * Lints drafted (or hand-edited) steps against the map: numbering, an actor on every step, one known action that is
 * not just looking, every control and menu label grounded in the map with a role that fits, inputs that are
 * references and not values, no step repeated right after itself.
 *
 * @remarks Pure. The problems come in step order, then in the order of {@link LintKind}. An empty list means the steps
 *   meet the template's mechanical rules, not that the case is right: a person still reviews it.
 * @see docs/adr/0038-case-drafter.md
 */
export function lintSteps(
  steps: readonly LintStep[],
  map: AppMap,
): LintProblem[] {
  const nav = navNames(map);
  return steps.flatMap((s, i) =>
    stepProblems(s, i, steps[i - 1], map, nav).map((kind) => ({
      kind,
      step: i,
    })),
  );
}
