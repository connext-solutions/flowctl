import { ConfigError } from '../../foundation/index.js';
import type { AppMap } from '../../observe/index.js';
import {
  normText,
  type Operation,
  quotedSpans,
  refusal,
} from '../../spec/index.js';
import type { OperationMatch, SpecSpan } from '../match/index.js';
import {
  type Mention,
  type Planned,
  planStep,
  type Quote,
  spanOf,
} from './plan.js';
import { type CaseDraft, EN_VERBS, type VerbRules } from './types.js';
import { checkVerbs, negationsIn, outsideQuotes, verbsIn } from './verbs.js';

/** Options of {@link draftCase}: the actor (else the operation's) and the verb rules (else {@link EN_VERBS}). */
export interface DraftOptions {
  actor?: string;
  verbs?: VerbRules;
}

const stepOf = (s: SpecSpan): number | null =>
  s.path.length === 2 && s.path[0] === 'steps' && typeof s.path[1] === 'number'
    ? s.path[1]
    : null;

/** Appends `item` to the list of `key` in `map`. */
function add<T>(map: Map<number, T[]>, key: number, item: T): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [item]);
  else list.push(item);
}

/** The quoted labels of the match entry grouped by step index, each list sorted by start: one pass over the spans. */
function quotesByStep(match: OperationMatch): Map<number, Quote[]> {
  const out = new Map<number, Quote[]>();
  for (const literal of match.literals)
    for (const span of literal.spans) {
      const i = stepOf(span);
      if (i !== null) add(out, i, { literal, span });
    }
  for (const list of out.values())
    list.sort((a, b) => a.span.start - b.span.start);
  return out;
}

/** The title mentions of the match entry grouped by step index, each list sorted by start. */
function mentionsByStep(match: OperationMatch): Map<number, Mention[]> {
  const out = new Map<number, Mention[]>();
  for (const c of match.screens)
    for (const e of c.evidence) {
      const i = e.kind === 'title-mention' ? stepOf(e.spec) : null;
      if (i !== null)
        add(out, i, {
          start: e.spec.start,
          end: e.spec.end,
          page: e.element.page,
        });
    }
  for (const list of out.values())
    list.sort((a, b) => a.start - b.start || a.end - b.end);
  return out;
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
 * @throws {ConfigError} when `match` is the entry of another operation, or the verb table is malformed.
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
  const rules = options.verbs ?? EN_VERBS;
  checkVerbs(rules);
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
  const quotesOf = quotesByStep(match);
  const mentionsOf = mentionsByStep(match);
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
    const quoted = quotedSpans(text);
    const plan = planStep({
      i,
      text,
      screen,
      map,
      verbs: verbsIn(text, rules, quoted),
      negations: negationsIn(text, rules, quoted),
      quotes: quotesOf.get(i) ?? [],
      mentions: outsideQuotes(mentionsOf.get(i) ?? [], quoted),
    });
    for (const o of plan.observed) draft.observed.push(o);
    if (plan.gaps.length > 0) for (const g of plan.gaps) draft.gaps.push(g);
    else for (const p of plan.steps) planned.push(p);
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
