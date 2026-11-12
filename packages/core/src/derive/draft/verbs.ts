import { ConfigError } from '../../foundation/index.js';
import { normText, occurrences, type Quoted } from '../../spec/index.js';
import { DRAFT_ACTIONS, type DraftAction, type VerbRules } from './types.js';

/** A verb found in a step: what it introduces and its UTF-16 offsets in the normalised step. */
export interface VerbAt {
  kind: DraftAction | 'observe';
  start: number;
  end: number;
}

/** UTF-16 offsets `[start, end)` in a normalised step. */
export interface At {
  start: number;
  end: number;
}

const KINDS: readonly (DraftAction | 'observe')[] = [
  ...DRAFT_ACTIONS,
  'observe',
];

const isWords = (v: unknown): boolean =>
  Array.isArray(v) && v.every((w) => typeof w === 'string');

/**
 * Checks a caller's verb table: an object whose every action and `observe` is an array of strings, with an optional
 * `negate` array of strings and no other key.
 *
 * @throws {ConfigError} when the table is malformed.
 */
export function checkVerbs(rules: unknown): asserts rules is VerbRules {
  const bad = (what: string): never => {
    throw new ConfigError(`verb table: ${what}`);
  };
  if (typeof rules !== 'object' || rules === null || Array.isArray(rules))
    bad('must be an object of word lists');
  const table = Object.fromEntries(Object.entries(rules as object));
  for (const key of KINDS)
    if (!isWords(table[key])) bad(`\`${key}\` must be an array of strings`);
  if (table['negate'] !== undefined && !isWords(table['negate']))
    bad('`negate` must be an array of strings');
  for (const key of Object.keys(table))
    if (key !== 'negate' && !KINDS.some((k) => k === key))
      bad(`unknown key \`${key}\``);
}

/**
 * The items of `found` (sorted by start) that overlap no quoted label of `quotes` (sorted, as `quotedSpans` gives
 * them), the quote marks included. One merge pass over both lists.
 */
export function outsideQuotes<T extends At>(
  found: readonly T[],
  quotes: readonly Quoted[],
): T[] {
  let q = 0;
  return found.filter((v) => {
    while (q < quotes.length && (quotes[q]?.end ?? 0) + 1 <= v.start) q += 1;
    const cur = quotes[q];
    return cur === undefined || v.end <= cur.start - 1;
  });
}

/** Every occurrence of the words in `text`, at token boundaries, case-insensitive, sorted by start. */
function wordsIn(text: string, words: readonly string[]): At[] {
  const all: At[] = [];
  for (const word of words) {
    const w = normText(word);
    if (w === '') continue;
    for (const o of occurrences(text, w))
      all.push({ start: o.start, end: o.end });
  }
  return all.sort((a, b) => a.start - b.start || b.end - a.end);
}

/**
 * The verbs of `rules` in `text` (normalised), in text order and never overlapping: each word at token boundaries,
 * case-insensitive, outside the quoted labels `quotes` of the same text (a verb inside `"Go to settings"` is part of
 * the label); at one start the longer word wins, and at equal length the kind first in {@link DRAFT_ACTIONS} order,
 * then `observe`; a word that starts inside a kept one is dropped.
 */
export function verbsIn(
  text: string,
  rules: VerbRules,
  quotes: readonly Quoted[],
): VerbAt[] {
  const all: (VerbAt & { order: number })[] = [];
  KINDS.forEach((kind, order) => {
    for (const w of wordsIn(text, rules[kind]))
      all.push({ kind, start: w.start, end: w.end, order });
  });
  all.sort((a, b) => a.start - b.start || b.end - a.end || a.order - b.order);
  const out: VerbAt[] = [];
  let reached = 0;
  for (const v of outsideQuotes(all, quotes)) {
    if (v.start < reached) continue;
    out.push({ kind: v.kind, start: v.start, end: v.end });
    reached = v.end;
  }
  return out;
}

/** The negation words of `rules` in `text` (normalised), outside the quoted labels `quotes`, sorted by start. */
export function negationsIn(
  text: string,
  rules: VerbRules,
  quotes: readonly Quoted[],
): At[] {
  return outsideQuotes(wordsIn(text, rules.negate ?? []), quotes);
}

/**
 * For each of `positions` (sorted), the index of the last verb that ends at or before it, or `-1`: the verb a quoted
 * label there belongs to. One merge pass over both lists (verbs never overlap, so their ends are sorted too).
 */
export function owners(
  verbs: readonly VerbAt[],
  positions: readonly number[],
): number[] {
  const out: number[] = [];
  let k = -1;
  for (const pos of positions) {
    while (k + 1 < verbs.length && (verbs[k + 1]?.end ?? 0) <= pos) k += 1;
    out.push(k);
  }
  return out;
}

/**
 * For each verb, the start of the first negation word between the verb before it (or the start of the step) and the
 * verb itself, or `undefined`. One merge pass over both lists.
 */
export function negatedAt(
  verbs: readonly VerbAt[],
  negations: readonly At[],
): (number | undefined)[] {
  let p = 0;
  return verbs.map((v, k) => {
    const from = verbs[k - 1]?.end ?? 0;
    while (p < negations.length && (negations[p]?.start ?? 0) < from) p += 1;
    const n = negations[p];
    return n !== undefined && n.end <= v.start ? n.start : undefined;
  });
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
