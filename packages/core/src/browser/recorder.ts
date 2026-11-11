import type { Page } from 'playwright';
import {
  ARIA_ROLES,
  escapeTemplates,
  type Loc,
  type TemplatedValue,
} from '../flow/index.js';
import { StepError } from './executor.js';
import { MARK_ATTRIBUTE } from './snapshot.js';

/**
 * Parses the first line of a Playwright aria snapshot.
 *
 * @remarks Playwright writes the line as a YAML key, so a name with `{`, `:` or `'` arrives quoted
 *   as a whole: `- 'button "Tổng {{x}}"': text`. That form is unwrapped first.
 *
 * @example parseAriaLine('- button "Gửi" [pressed]') // { role: 'button', name: 'Gửi' }
 * @internal
 */
export function parseAriaLine(
  line: string,
): { role: string; name: string } | undefined {
  const single = /^\s*- '((?:[^']|'')*)'/.exec(line)?.[1];
  const double = /^\s*- ("(?:[^"\\]|\\.)*")/.exec(line)?.[1];
  const head =
    single !== undefined
      ? `- ${single.replaceAll("''", "'")}`
      : double !== undefined
        ? `- ${String(JSON.parse(double))}`
        : line;
  const m = /^\s*- ([a-z]+)(?: ("(?:[^"\\]|\\.)*"))?/.exec(head);
  const role = m?.[1];
  if (role === undefined) return undefined;
  const quoted = m?.[2];
  return { role, name: quoted === undefined ? '' : String(JSON.parse(quoted)) };
}

/**
 * The replayable locator of the element marked with `token`: its test id, else its role and
 * accessible name exactly as Playwright computes them.
 *
 * @remarks Never the snapshot label: labels differ from accessible names ("Tên ngày nghỉ *" vs
 *   "Tên ngày nghỉ*") and comboboxes are labelled by their value, which replayed 0/10 in the
 *   spike. Values the run expanded from templates (`o.templated`: the uid and templated inputs) are
 *   turned back into their templates so the name matches on replay.
 * @throws {StepError} `not_found` when the marked element is gone; `action_failed` when its role
 *   is not one flowctl can replay.
 * @see docs/adr/0009-locator-strategy.md
 */
export async function recordLoc(
  page: Page,
  token: string,
  o: { testIdAttribute: string; templated: TemplatedValue[] },
): Promise<Loc> {
  const l = page.locator(`[${MARK_ATTRIBUTE}="${token}"]`);
  let testId: string | null;
  let aria = '';
  try {
    testId = await l.getAttribute(o.testIdAttribute, { timeout: 1000 });
    if (testId === null || testId === '')
      aria = await l.ariaSnapshot({ timeout: 1000 });
  } catch {
    throw new StepError(
      'not_found',
      'the chosen element disappeared before it could be recorded',
    );
  }
  if (testId !== null && testId !== '') return { testId };
  const first = aria.split('\n')[0] ?? '';
  const parsed = parseAriaLine(first);
  const role = ARIA_ROLES.find((r) => r === parsed?.role);
  if (parsed === undefined || role === undefined)
    throw new StepError(
      'action_failed',
      `cannot record a locator for "${first}"`,
    );
  return { role, name: templateName(parsed.name, o.templated) };
}

/**
 * Turns an accessible name into flow text: literal `{{` is escaped (so replay does not expand it)
 * and every value the run expanded from a template (the uid, a templated input) becomes its template
 * again, longest value first.
 *
 * @remarks Only values the run itself produced are turned back: a date or env value that merely
 *   appears on the page (a list column showing today) stays literal, because nothing ties it to a
 *   template (#24).
 * @example templateName('Tổng {{x}} ab12cd34', [{ value: 'ab12cd34', template: '{{uid}}' }])
 *   // 'Tổng {{lbrace}}x}} {{uid}}'
 * @internal
 */
export function templateName(name: string, known: TemplatedValue[]): string {
  const [first, ...rest] = known;
  if (first === undefined) return escapeTemplates(name);
  return name
    .split(first.value)
    .map((part) => templateName(part, rest))
    .join(first.template);
}
