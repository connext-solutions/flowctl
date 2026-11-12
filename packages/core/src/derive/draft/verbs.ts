import { normText, occurrences } from '../../spec/index.js';
import { DRAFT_ACTIONS, type DraftAction, type VerbRules } from './types.js';

/** A verb found in a step: what it introduces and its UTF-16 offsets in the normalised step. */
export interface VerbAt {
  kind: DraftAction | 'observe';
  start: number;
  end: number;
}

const KINDS: readonly (DraftAction | 'observe')[] = [
  ...DRAFT_ACTIONS,
  'observe',
];

/**
 * The verbs of `rules` in `text` (normalised), in text order and never overlapping: each word at token boundaries,
 * case-insensitive; at one start the longer word wins, and at equal length the kind first in {@link DRAFT_ACTIONS}
 * order, then `observe`; a word that starts inside a kept one is dropped.
 */
export function verbsIn(text: string, rules: VerbRules): VerbAt[] {
  const all: (VerbAt & { order: number })[] = [];
  KINDS.forEach((kind, order) => {
    for (const word of rules[kind]) {
      const w = normText(word);
      if (w === '') continue;
      for (const o of occurrences(text, w))
        all.push({ kind, start: o.start, end: o.end, order });
    }
  });
  all.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const out: VerbAt[] = [];
  let reached = 0;
  for (const v of all) {
    if (v.start < reached) continue;
    out.push({ kind: v.kind, start: v.start, end: v.end });
    reached = v.end;
  }
  return out;
}

/** The index of the last verb that ends at or before `pos`, or `-1`: the verb a quoted label at `pos` belongs to. */
export function governing(verbs: readonly VerbAt[], pos: number): number {
  let found = -1;
  verbs.forEach((v, i) => {
    if (v.end <= pos) found = i;
  });
  return found;
}

/** The segment of a step a verb governs: from its start to the next verb's start (or the end), trailing space cut. */
export function segment(
  text: string,
  verbs: readonly VerbAt[],
  i: number,
): { start: number; end: number } {
  const start = verbs[i]?.start ?? 0;
  const end = start + text.slice(start, verbs[i + 1]?.start).trimEnd().length;
  return { start, end };
}
