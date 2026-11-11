import type { Control } from '../browser/index.js';
import { maskSecrets } from '../foundation/index.js';
import { redactText } from '../run/index.js';

/** The longest control name or value an escalation returns. */
export const MAX_LABEL_CHARS = 120;
/** The longest `detail` or `failed.got` an escalation returns. */
export const MAX_DETAIL_CHARS = 500;

const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/gu;

/**
 * Page-derived text as data for the orchestrator (issue #49): every typed secret value becomes `***`, control,
 * format (bidi, zero-width), private-use and unassigned characters are removed, line breaks and runs of
 * whitespace become one space, and the result is cut at `max` characters. A page therefore cannot fake a new line, a
 * control row or an instruction block in what the orchestrator reads.
 *
 * @remarks Secrets are masked before anything else, so a cut never leaves part of a secret visible, and again
 *   after the hidden characters are removed, so a secret split by zero-width characters is masked too
 *   (ADR 0006, invariant 4: the orchestrator is a model too).
 */
export function pageText(
  text: string,
  secrets: readonly string[],
  max: number,
): string {
  const flat = redactText(text, secrets)
    .replace(/\s+/g, ' ')
    .replace(HIDDEN, '')
    .trim();
  const clean = maskSecrets(flat, secrets);
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

/**
 * One row of an escalation's control table: `[id] role "name"` (and ` = "value"`), with name and value passed
 * through {@link pageText} and JSON-quoted, so a quote inside a label cannot end the field.
 */
export function controlRow(c: Control, secrets: readonly string[]): string {
  const name = JSON.stringify(pageText(c.name, secrets, MAX_LABEL_CHARS));
  const value =
    c.value === ''
      ? ''
      : ` = ${JSON.stringify(pageText(c.value, secrets, MAX_LABEL_CHARS))}`;
  return `[${c.id}] ${pageText(c.role, secrets, 40)} ${name}${value}`;
}
