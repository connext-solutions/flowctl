import type { AppMap } from '../../observe/index.js';
import type { LiteralMatch, SpecSpan } from '../match/index.js';
import { groundPath, groundTarget, groundVia, pageTitled } from './ground.js';
import {
  ACTION_ROLES,
  type DraftAction,
  type DraftGap,
  type DraftStep,
  type GapReason,
} from './types.js';
import { type At, negatedAt, owners, segment, type VerbAt } from './verbs.js';

/** A quoted label of one step: the literal and the span of this occurrence. */
export interface Quote {
  literal: LiteralMatch;
  span: SpecSpan;
}

/** A step before numbering: no number, actor or input reference yet. */
export type Planned = Omit<DraftStep, 'n' | 'actor' | 'input'>;

/** What one spec step gives: the planned actions, the gaps and the parts that only observe. */
export interface StepPlan {
  steps: Planned[];
  gaps: DraftGap[];
  observed: SpecSpan[];
}

/** A title mention of one step (ADR 0034 `title-mention`): its span and the page whose title it is. */
export interface Mention {
  start: number;
  end: number;
  page: string;
}

/**
 * What the drafter reads for one spec step: its index and normalised text, the screen, the map, its verbs, negation
 * words, quoted labels and title mentions (each sorted by start, and verbs, negations and mentions outside quotes).
 */
export interface StepInput {
  i: number;
  text: string;
  screen: string;
  map: AppMap;
  verbs: readonly VerbAt[];
  negations: readonly At[];
  quotes: readonly Quote[];
  mentions: readonly Mention[];
}

/** The roles a `select` verb picks by clicking (one choice, no value): drafted as a `click` with no input. */
const PICK_ROLES: readonly string[] = ['radio', 'option'];

export const spanOf = (
  i: number,
  text: string,
  start: number,
  end: number,
) => ({
  path: ['steps', i],
  start,
  end,
  text: text.slice(start, end),
});

/** The index of the first item of `list` (sorted by start) that starts at or after `pos`. */
function firstFrom(list: readonly At[], pos: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((list[mid]?.start ?? 0) < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The pages a step's text mentions by title (ADR 0034 `title-mention`, outside quotes) within `[start, end)`. */
function mentioned(input: StepInput, start: number, end: number): string[] {
  const pages = new Set<string>();
  const list = input.mentions;
  for (let k = firstFrom(list, start); k < list.length; k += 1) {
    const m = list[k];
    if (m === undefined || m.start >= end) break;
    if (m.end <= end) pages.add(m.page);
  }
  return [...pages].sort();
}

/** The open step a verb gives: a menu path, a quoted address or page title, or the one page its segment mentions. */
function openStep(
  input: StepInput,
  quotes: readonly Quote[],
  source: SpecSpan,
): { ok: Planned } | { gap: DraftGap } {
  const gap = (reason: DraftGap['reason'], span: SpecSpan) => ({
    gap: { reason, step: input.i, span },
  });
  const via: string[] = [];
  const pages: string[] = [];
  for (const q of quotes) {
    if (q.literal.kind === 'path') {
      const g = groundPath(q.literal);
      if ('gap' in g) return gap(g.gap, q.span);
      pages.push(g.ok);
      continue;
    }
    const g = groundVia(q.literal);
    if ('ok' in g) {
      via.push(g.ok);
      continue;
    }
    const titled =
      g.gap === 'refused' ? undefined : pageTitled(input.map, q.literal.text);
    if (titled === undefined) return gap(g.gap, q.span);
    pages.push(titled);
  }
  if (quotes.length === 0)
    pages.push(...mentioned(input, source.start, source.end));
  const last = via.at(-1);
  if (pages.length === 0 && last !== undefined) {
    const titled = pageTitled(input.map, last);
    if (titled !== undefined) pages.push(titled);
  }
  if (new Set(pages).size > 1) return gap('ambiguous', source);
  const page = pages[0];
  if (page === undefined && via.length === 0) return gap('unquoted', source);
  return {
    ok: {
      action: 'open',
      ...(via.length > 0 ? { via } : {}),
      ...(page !== undefined ? { page } : {}),
      source,
    },
  };
}

/**
 * The action a quoted label takes after a `click`, `fill`, `select` or `check` verb: the verb's action on the one
 * control of the screen with a role that can take it, or, for `select` with none, a `click` on the one `radio` or
 * `option` of that label.
 */
function actionStep(
  input: StepInput,
  q: Quote,
  kind: Exclude<DraftAction, 'open'>,
): { ok: Planned } | { gap: GapReason } {
  const { screen, map } = input;
  const g = groundTarget(q.literal, ACTION_ROLES[kind], screen, map);
  if ('ok' in g) return { ok: { action: kind, target: g.ok, source: q.span } };
  if (kind !== 'select' || g.gap !== 'role_mismatch') return g;
  const pick = groundTarget(q.literal, PICK_ROLES, screen, map);
  return 'ok' in pick
    ? { ok: { action: 'click', target: pick.ok, source: q.span } }
    : pick;
}

/**
 * Plans one spec step: each verb's quoted labels become actions, observing parts are set aside, the rest are gaps.
 * Linear in the step's verbs, quotes and mentions: each quote gets its verb in one merge pass.
 */
export function planStep(input: StepInput): StepPlan {
  const { i, text, verbs, quotes } = input;
  const plan: StepPlan = { steps: [], gaps: [], observed: [] };
  const whole = spanOf(i, text, 0, text.length);
  if (verbs.length > 0 && verbs.every((v) => v.kind === 'observe'))
    return { ...plan, observed: [whole] };
  if (verbs.length === 0 && quotes.length === 0)
    return { ...plan, gaps: [{ reason: 'no_verb', step: i, span: whole }] };
  const owner = owners(
    verbs,
    quotes.map((q) => q.span.start),
  );
  const mine: Quote[][] = verbs.map(() => []);
  quotes.forEach((q, j) => {
    const k = owner[j] ?? -1;
    if (k < 0) plan.gaps.push({ reason: 'no_verb', step: i, span: q.span });
    else mine[k]?.push(q);
  });
  const negated = negatedAt(verbs, input.negations);
  verbs.forEach((v, k) => {
    const seg = segment(text, verbs, k);
    const source = spanOf(i, text, seg.start, seg.end);
    const own = mine[k] ?? [];
    if (v.kind === 'observe') {
      plan.observed.push(source);
      return;
    }
    const neg = negated[k];
    if (neg !== undefined) {
      plan.gaps.push({
        reason: 'negated',
        step: i,
        span: spanOf(i, text, neg, seg.end),
      });
      return;
    }
    if (v.kind === 'open') {
      const g = openStep(input, own, source);
      if ('gap' in g) plan.gaps.push(g.gap);
      else plan.steps.push(g.ok);
      return;
    }
    if (own.length === 0) {
      plan.gaps.push({ reason: 'unquoted', step: i, span: source });
      return;
    }
    const kind = v.kind;
    const takesValue = kind === 'fill' || kind === 'select';
    own.forEach((q, n) => {
      if (takesValue && n > 0) {
        plan.gaps.push({ reason: 'quoted_value', step: i, span: q.span });
        return;
      }
      const g = actionStep(input, q, kind);
      if ('gap' in g) plan.gaps.push({ reason: g.gap, step: i, span: q.span });
      else plan.steps.push(g.ok);
    });
  });
  return plan;
}
