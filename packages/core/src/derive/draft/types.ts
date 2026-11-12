import type { SpecSpan } from '../match/index.js';

/**
 * The actions a drafted step may take, one per step: open a screen (by its address or a menu path), click a control,
 * fill a field, select in a field, check a box. Observing is not an action: it belongs to the case's Expected.
 */
export const DRAFT_ACTIONS = [
  'open',
  'click',
  'fill',
  'select',
  'check',
] as const;

/** One of {@link DRAFT_ACTIONS}. */
export type DraftAction = (typeof DRAFT_ACTIONS)[number];

/**
 * The control a step acts on, as the `AppMap` holds it: its role and name (the map's text, never the spec's) and the
 * JSON Pointer of the element in `appmap.json` (`/pages/1/controls/2`, `/pages/1/forms/0/fields/0`).
 */
export interface DraftTarget {
  role: string;
  name: string;
  pointer: string;
}

/**
 * One drafted step: its number, who acts (a profile or role name), one action and what it acts on.
 *
 * - `target`: the control, for `click`, `fill`, `select` and `check`;
 * - `input`: for `fill` and `select`, the name of a step input (a flow name, `input-1`), never the value itself
 *   (ADR 0006: values come from the orchestrator);
 * - `via`: for `open`, the menu path labels in order, each a navigation control of the map;
 * - `page`: for `open`, the page path it reaches, when known;
 * - `source`: the span of the operation's text the step comes from (a quoted label, or the step).
 */
export interface DraftStep {
  n: number;
  actor: string;
  action: DraftAction;
  target?: DraftTarget;
  input?: string;
  via?: string[];
  page?: string;
  source: SpecSpan;
}

/**
 * Why a spec step, or part of it, gave no drafted step:
 * - `no_actor`: neither the caller nor the operation names an actor, or the name is refused (ADR 0020 section d);
 * - `no_screen`: the match report has no single screen for the operation;
 * - `no_verb`: a quoted label, or the whole step, follows no verb of the table;
 * - `unquoted`: an action verb with no quoted label to act on (and, for `open`, no page named);
 * - `label_not_found`: a quoted label equals no element of the map;
 * - `label_not_on_screen`: it equals elements of other pages only;
 * - `role_mismatch`: it equals elements of the screen whose role cannot take the action;
 * - `ambiguous`: it equals more than one element of the screen that can take the action;
 * - `refused`: the Unicode rules refuse the label (ADR 0020 section d).
 */
export type GapReason =
  | 'no_actor'
  | 'no_screen'
  | 'no_verb'
  | 'unquoted'
  | 'label_not_found'
  | 'label_not_on_screen'
  | 'role_mismatch'
  | 'ambiguous'
  | 'refused';

/** A part of the operation the drafter could not ground: the step index and the span (both `null` for `no_actor`). */
export interface DraftGap {
  reason: GapReason;
  step: number | null;
  span: SpecSpan | null;
}

/**
 * A draft test case's steps for one operation: the operation, the screen it happens on, the steps, and what could not
 * be drafted. `status` is always `unverified`: a person reviews a draft, and only a confirming run makes it a flow.
 * `observed` holds the parts of steps that only look (`Check that …`), left for the case's Expected (T4.3).
 */
export interface CaseDraft {
  operation: { id: string; provider: string; ref: string };
  screen: string | null;
  steps: DraftStep[];
  status: 'unverified';
  gaps: DraftGap[];
  observed: SpecSpan[];
}

/**
 * The fixed verb rules: per action, and for observing, the words that introduce it in spec text. A word matches at
 * token boundaries, case-insensitive (ADR 0020 amendment 2026-11-12, section 2); where two words start at the same
 * place, the longer one wins (`check that` over `check`).
 */
export type VerbRules = Readonly<
  Record<DraftAction | 'observe', readonly string[]>
>;

/** The English verb rules, the default. A caller drafting from spec text in another language passes its own. */
export const EN_VERBS: VerbRules = {
  open: ['open', 'go to', 'navigate to', 'visit'],
  click: ['click', 'press', 'tap'],
  fill: ['fill', 'fill in', 'enter', 'type'],
  select: ['select', 'choose', 'pick'],
  check: ['check', 'tick'],
  observe: [
    'see',
    'verify',
    'check that',
    'observe',
    'look at',
    'confirm that',
  ],
};

/** The roles that can take each action other than `open`. */
export const ACTION_ROLES: Readonly<
  Record<Exclude<DraftAction, 'open'>, readonly string[]>
> = {
  click: [
    'button',
    'link',
    'tab',
    'menuitem',
    'menuitemcheckbox',
    'menuitemradio',
    'treeitem',
    'option',
    'checkbox',
    'radio',
    'switch',
  ],
  fill: ['textbox', 'searchbox', 'spinbutton', 'combobox'],
  select: ['combobox', 'listbox', 'radio', 'option'],
  check: ['checkbox', 'radio', 'switch', 'menuitemcheckbox'],
};

/** The roles a menu path label may have: navigation controls. */
export const NAV_ROLES: readonly string[] = [
  'link',
  'menuitem',
  'tab',
  'treeitem',
];
