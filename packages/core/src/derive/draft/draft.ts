import { ConfigError } from '../../foundation/index.js';
import type { AppMap } from '../../observe/index.js';
import { normText, type Operation, refusal } from '../../spec/index.js';
import type { LiteralMatch, OperationMatch, SpecSpan } from '../match/index.js';
import { groundPath, groundTarget, groundVia, pageTitled } from './ground.js';
import {
  type CaseDraft,
  type DraftGap,
  type DraftStep,
  EN_VERBS,
  type VerbRules,
} from './types.js';
import { governing, segment, type VerbAt, verbsIn } from './verbs.js';

/** Options of {@link draftCase}: the actor (else the operation's) and the verb rules (else {@link EN_VERBS}). */
export interface DraftOptions {
  actor?: string;
  verbs?: VerbRules;
}

/** A quoted label of one step: the literal and the span of this occurrence. */
interface Quote {
  literal: LiteralMatch;
  span: SpecSpan;
}

type Planned = Omit<DraftStep, 'n' | 'actor' | 'input'>;

/** What one spec step gives: the planned actions, the gaps and the parts that only observe. */
interface StepPlan {
  steps: Planned[];
  gaps: DraftGap[];
  observed: SpecSpan[];
}

/** What the drafter reads for one spec step: its index and normalised text, the screen, the match entry and map. */
interface StepInput {
  i: number;
  text: string;
  screen: string;
  match: OperationMatch;
  map: AppMap;
  verbs: readonly VerbAt[];
}

const spanOf = (i: number, text: string, start: number, end: number) => ({
  path: ['steps', i],
  start,
  end,
  text: text.slice(start, end),
});

const quotesIn = (match: OperationMatch, i: number): Quote[] =>
  match.literals
    .flatMap((literal) =>
      literal.spans
        .filter((s) => s.path[0] === 'steps' && s.path[1] === i)
        .map((span) => ({ literal, span })),
    )
    .sort((a, b) => a.span.start - b.span.start);

/** The pages a step's text mentions by title (ADR 0034 `title-mention`) within `[start, end)`. */
function mentioned(input: StepInput, start: number, end: number): string[] {
  const pages = input.match.screens.flatMap((c) =>
    c.evidence
      .filter(
        (e) =>
          e.kind === 'title-mention' &&
          e.spec.path[0] === 'steps' &&
          e.spec.path[1] === input.i &&
          e.spec.start >= start &&
          e.spec.end <= end,
      )
      .map((e) => e.element.page),
  );
  return [...new Set(pages)].sort();
}

/** The open step a verb gives: a menu path, a quoted address, or the one page its segment mentions. */
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
    const g =
      q.literal.kind === 'path' ? groundPath(q.literal) : groundVia(q.literal);
    if ('gap' in g) return gap(g.gap, q.span);
    (q.literal.kind === 'path' ? pages : via).push(g.ok);
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

/** Plans one spec step: each verb's quoted labels become actions, observing parts are set aside, the rest are gaps. */
function planStep(input: StepInput): StepPlan {
  const { i, text, verbs } = input;
  const plan: StepPlan = { steps: [], gaps: [], observed: [] };
  const whole = spanOf(i, text, 0, text.length);
  if (verbs.length > 0 && verbs.every((v) => v.kind === 'observe'))
    return { ...plan, observed: [whole] };
  const quotes = quotesIn(input.match, i);
  if (verbs.length === 0 && quotes.length === 0)
    return { ...plan, gaps: [{ reason: 'no_verb', step: i, span: whole }] };
  for (const q of quotes)
    if (governing(verbs, q.span.start) < 0)
      plan.gaps.push({ reason: 'no_verb', step: i, span: q.span });
  verbs.forEach((v, k) => {
    const seg = segment(text, verbs, k);
    const source = spanOf(i, text, seg.start, seg.end);
    const mine = quotes.filter((q) => governing(verbs, q.span.start) === k);
    if (v.kind === 'observe') {
      plan.observed.push(source);
      return;
    }
    if (v.kind === 'open') {
      const g = openStep(input, mine, source);
      if ('gap' in g) plan.gaps.push(g.gap);
      else plan.steps.push(g.ok);
      return;
    }
    if (mine.length === 0) {
      plan.gaps.push({ reason: 'unquoted', step: i, span: source });
      return;
    }
    for (const q of mine) {
      const g = groundTarget(q.literal, v.kind, input.screen, input.map);
      if ('gap' in g) plan.gaps.push({ reason: g.gap, step: i, span: q.span });
      else plan.steps.push({ action: v.kind, target: g.ok, source: q.span });
    }
  });
  return plan;
}

/**
 * Drafts the steps of a test case for one operation from its match report entry, without a model (task T4.2): each
 * quoted label of a step, after a verb of the table, becomes one action on the one control of the matched screen it
 * equals; an `open` verb gives a menu path, a quoted address or the page its words name. A spec step with any part
 * that cannot be grounded goes to `gaps` whole, never into `steps`; the parts that only observe go to `observed`.
 *
 * @remarks Pure and deterministic. Every target is the map's element (role, name, pointer), never spec text; every
 *   `fill` and `select` gets a fresh input reference (`input-1`, `input-2`, …), never a value, and no provider text
 *   becomes an input name (ADR 0023 provider input hardening, rule 1). No actor (the caller's, else the operation's)
 *   means no steps and one `no_actor` gap.
 * @throws {ConfigError} when `match` is the entry of another operation.
 * @see docs/adr/0038-case-drafter.md
 */
export function draftCase(
  op: Operation,
  match: OperationMatch,
  map: AppMap,
  options: DraftOptions = {},
): CaseDraft {
  const m = match.operation;
  if (
    m.id !== op.id ||
    m.provider !== op.location.provider ||
    m.ref !== op.location.ref
  )
    throw new ConfigError(
      `the match entry is for another operation (${m.id}, not ${op.id}): pass the entry matchOperations gave for it`,
    );
  const screen = match.screen.status === 'matched' ? match.screen.page : null;
  const draft: CaseDraft = {
    operation: {
      id: op.id,
      provider: op.location.provider,
      ref: op.location.ref,
    },
    screen,
    steps: [],
    status: 'unverified',
    gaps: [],
    observed: [],
  };
  const planned: Planned[] = [];
  op.steps.forEach((raw, i) => {
    const text = normText(raw);
    if (screen === null) {
      draft.gaps.push({
        reason: 'no_screen',
        step: i,
        span: spanOf(i, text, 0, text.length),
      });
      return;
    }
    const verbs = verbsIn(text, options.verbs ?? EN_VERBS);
    const plan = planStep({ i, text, screen, match, map, verbs });
    draft.observed.push(...plan.observed);
    if (plan.gaps.length > 0) draft.gaps.push(...plan.gaps);
    else planned.push(...plan.steps);
  });
  const actor = normText(options.actor ?? op.actor ?? '');
  if (actor === '' || refusal(actor) !== null) {
    draft.gaps.unshift({ reason: 'no_actor', step: null, span: null });
    return draft;
  }
  let inputs = 0;
  draft.steps = planned.map((p, k) => {
    const needsInput = p.action === 'fill' || p.action === 'select';
    if (needsInput) inputs += 1;
    return {
      n: k + 1,
      actor,
      ...p,
      ...(needsInput ? { input: `input-${inputs}` } : {}),
    };
  });
  return draft;
}
