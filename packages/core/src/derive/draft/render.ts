import { ConfigError, NAME_PATTERN } from '../../foundation/index.js';
import { INVISIBLE_CLASS } from '../../spec/index.js';
import { cutShown, marker, showInvisible } from '../escape.js';
import type { CaseDraft, DraftStep } from './types.js';

/**
 * The phrases a step is written with, one per action (`openVia` for an `open` with a menu path), and the separator
 * between menu path labels. A phrase names its values by placeholder: `{actor}`, `{target}`, `{input}`, `{page}`,
 * `{via}`. Every phrase and the separator are one line of visible text; the separator holds no placeholder, quote
 * mark (`"`, `“`, `”`) or backslash, so it cannot open or close a menu label's quote.
 */
export interface PhraseTable {
  open: string;
  openVia: string;
  click: string;
  fill: string;
  select: string;
  check: string;
  viaSeparator: string;
}

const PHRASES = [
  'open',
  'openVia',
  'click',
  'fill',
  'select',
  'check',
] as const;
type Phrase = (typeof PHRASES)[number];
type Slot = 'actor' | 'target' | 'input' | 'page' | 'via';

/** The placeholders each phrase must hold, and may hold: exactly these. */
const SLOTS: Readonly<Record<Phrase, readonly Slot[]>> = {
  open: ['actor', 'page'],
  openVia: ['actor', 'via'],
  click: ['actor', 'target'],
  fill: ['actor', 'target', 'input'],
  select: ['actor', 'target', 'input'],
  check: ['actor', 'target'],
};

/** The English phrases, the default. */
export const EN_PHRASES: PhraseTable = {
  open: '{actor}: open the page {page}.',
  openVia: '{actor}: go to {via}.',
  click: '{actor}: click {target}.',
  fill: '{actor}: type the input {input} into {target}.',
  select: '{actor}: in {target}, choose the input {input}.',
  check: '{actor}: tick {target}.',
  viaSeparator: ' › ',
};

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;
const HAS_PLACEHOLDER = /\{[A-Za-z]+\}/;
const INVISIBLE = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');
/** The code points that open or close a quote for `quotedSpans`, and the backslash. */
const QUOTE_MARKS = /["“”\\]/g;

/**
 * Untrusted text (spec, page or caller) as one quoted value on one line: cut at 500 code points, invisible and control
 * code points (line breaks included) shown as `⟨U+XXXX⟩`, and so are `"`, `“`, `”` and `\` (no backslash escaping),
 * inside `"…"`. So a value can neither close its quote (for a reader or for `quotedSpans`), start a new step line,
 * hide or reorder text, nor be read as a placeholder.
 *
 * @see docs/adr/0023-spec-provider-seam.md
 */
export const quoteValue = (raw: string): string =>
  `"${showInvisible(cutShown(raw)).replace(QUOTE_MARKS, marker)}"`;

/** The input reference of a step as `⟨input-1⟩`. @throws {ConfigError} when it is no flow name (it may be a value). */
function inputRef(input: string | undefined): string {
  if (input === undefined || !NAME_PATTERN.test(input))
    throw new ConfigError(
      'renderSteps: a `fill` or `select` step needs an input reference that is a flow name (input-1)',
    );
  return `⟨${input}⟩`;
}

/** The actor bare when it is a plain name (a flow name such as `staff`), else quoted with {@link quoteValue}. */
const actorText = (actor: string): string =>
  NAME_PATTERN.test(actor) ? actor : quoteValue(actor);

/**
 * @throws {ConfigError} when a phrase misses a placeholder it needs, names another one, or holds an invisible code
 *   point (a line break included), or when the separator is not plain visible text without quote marks.
 */
function checkTable(t: PhraseTable): void {
  const bad = (what: string): never => {
    throw new ConfigError(`phrase table: ${what}`);
  };
  if (
    INVISIBLE.test(t.viaSeparator) ||
    HAS_PLACEHOLDER.test(t.viaSeparator) ||
    /["“”\\]/.test(t.viaSeparator)
  )
    bad(
      '`viaSeparator` must be visible text on one line, with no placeholder, quote mark or backslash',
    );
  for (const key of PHRASES) {
    const phrase = t[key];
    if (INVISIBLE.test(phrase))
      bad(`\`${key}\` must be one line of visible text`);
    const used = [...phrase.matchAll(PLACEHOLDER)].map((m) => m[1] ?? '');
    const allowed: readonly string[] = SLOTS[key];
    for (const u of used)
      if (!allowed.includes(u)) bad(`\`${key}\` may not hold {${u}}`);
    for (const need of allowed)
      if (!used.includes(need)) bad(`\`${key}\` must hold {${need}}`);
  }
}

/** The phrase and the quoted values of one step. */
function line(s: DraftStep, t: PhraseTable): string {
  const via = s.via ?? [];
  const key: Phrase =
    s.action === 'open' ? (via.length > 0 ? 'openVia' : 'open') : s.action;
  const values: Readonly<Record<Slot, () => string>> = {
    actor: () => actorText(s.actor),
    target: () => quoteValue(s.target?.name ?? ''),
    input: () => inputRef(s.input),
    page: () => quoteValue(s.page ?? ''),
    via: () => via.map(quoteValue).join(t.viaSeparator),
  };
  const isSlot = (name: string): name is Slot =>
    SLOTS[key].some((x) => x === name);
  const phrase = t[key].replace(PLACEHOLDER, (whole, name: string) =>
    isSlot(name) ? values[name]() : whole,
  );
  return `${s.n}. ${phrase}`;
}

/**
 * Writes a draft's steps as numbered lines (`1. …`), one per step, joined with `\n`, from a phrase table: the English
 * one by default, or a caller's in another language.
 *
 * @remarks Every value enters the line in one replacement pass, so a placeholder inside a value is never expanded:
 *   a control name, page and menu label through {@link quoteValue}, so provider and page text stays quoted data (ADR
 *   0023); the actor bare when it is a plain flow name, else through {@link quoteValue}; the input reference as
 *   `⟨input-1⟩`, only when it is a flow name. The output is plain text; a caller writing markdown escapes it for that
 *   surface.
 * @throws {ConfigError} when the table is malformed (see {@link PhraseTable}), or a `fill` or `select` step has no
 *   input reference that is a flow name.
 * @see docs/adr/0038-case-drafter.md
 */
export function renderSteps(
  draft: CaseDraft,
  phrases: PhraseTable = EN_PHRASES,
): string {
  checkTable(phrases);
  return draft.steps.map((s) => line(s, phrases)).join('\n');
}
