import { ConfigError } from '../../foundation/index.js';
import { cutShown, showInvisible } from '../escape.js';
import type { CaseDraft, DraftStep } from './types.js';

/**
 * The phrases a step is written with, one per action (`openVia` for an `open` with a menu path), and the separator
 * between menu path labels. A phrase names its values by placeholder: `{actor}`, `{target}`, `{input}`, `{page}`,
 * `{via}`.
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
const BREAK = /[\p{Cc}\p{Zl}\p{Zp}]/u;

/**
 * Untrusted text (spec, page or caller) as one quoted value on one line: cut at 500 code points, invisible and control
 * code points (line breaks included) shown as `⟨U+XXXX⟩`, then `\` and `"` escaped with `\`, inside `"…"`. So a value
 * can neither close its quote, start a new step line, hide or reorder text, nor be read as a placeholder.
 *
 * @see docs/adr/0023-spec-provider-seam.md
 */
export const quoteValue = (raw: string): string =>
  `"${showInvisible(cutShown(raw)).replace(/[\\"]/g, '\\$&')}"`;

/** @throws {ConfigError} when a phrase misses a placeholder it needs, names another one, or holds a line break. */
function checkTable(t: PhraseTable): void {
  const bad = (what: string): never => {
    throw new ConfigError(`phrase table: ${what}`);
  };
  if (BREAK.test(t.viaSeparator) || HAS_PLACEHOLDER.test(t.viaSeparator))
    bad('`viaSeparator` must be plain text on one line');
  for (const key of PHRASES) {
    const phrase = t[key];
    if (BREAK.test(phrase)) bad(`\`${key}\` must be one line`);
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
  const values = new Map<string, string>([
    ['actor', quoteValue(s.actor)],
    ['target', quoteValue(s.target?.name ?? '')],
    ['input', quoteValue(s.input ?? '')],
    ['page', quoteValue(s.page ?? '')],
    ['via', via.map(quoteValue).join(t.viaSeparator)],
  ]);
  const phrase = t[key].replace(
    PLACEHOLDER,
    (whole, name: string) => values.get(name) ?? whole,
  );
  return `${s.n}. ${phrase}`;
}

/**
 * Writes a draft's steps as numbered lines (`1. …`), one per step, joined with `\n`, from a phrase table: the English
 * one by default, or a caller's in another language.
 *
 * @remarks Every value (actor, control name, input reference, page, menu label) enters the line only through
 *   {@link quoteValue}, in one pass, so provider and page text stays quoted data (ADR 0023): a placeholder inside a
 *   value is never expanded. The output is plain text; a caller writing markdown escapes it for that surface.
 * @throws {ConfigError} when the table is malformed (see {@link PhraseTable}).
 * @see docs/adr/0038-case-drafter.md
 */
export function renderSteps(
  draft: CaseDraft,
  phrases: PhraseTable = EN_PHRASES,
): string {
  checkTable(phrases);
  return draft.steps.map((s) => line(s, phrases)).join('\n');
}
