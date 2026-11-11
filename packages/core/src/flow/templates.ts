import { randomUUID } from 'node:crypto';
import dayjs, { type Dayjs } from 'dayjs';
import { maskSecrets } from '../foundation/index.js';
import { FlowError, type FlowDoc } from './schema.js';

export interface TemplateContext {
  uid: string;
  now: Dayjs;
  /** The env's `vars`, for `{{env.NAME}}`. */
  vars: Record<string, string>;
}

export const newTemplateContext = (
  vars: Record<string, string> = {},
): TemplateContext => ({
  uid: randomUUID().slice(0, 8),
  now: dayjs(),
  vars,
});

/** A value the run expanded from a template, and the template text that produced it (#24). */
export interface TemplatedValue {
  value: string;
  template: string;
}

const ENV_REF = /^env\.([A-Za-z0-9_]+)$/;

const DATE_REF = /^today\s*(?:([+-])\s*(\d+))?\s*(?::\s*(\S[^}]*?))?$/;

/**
 * Makes `text` safe to embed in a flow: every `{{` becomes `{{lbrace}}`, which expands back to `{{`.
 *
 * @example escapeTemplates('Tổng {{total}}') // 'Tổng {{lbrace}}total}}'
 * @remarks Only the opening pair needs escaping, so the result round-trips through {@link expand}
 *   for any input, including text that already contains `{{lbrace}}`.
 */
export function escapeTemplates(text: string): string {
  return text.replaceAll('{{', '{{lbrace}}');
}

const ALLOWED =
  'allowed: {{uid}}, {{today}}, {{today+N}}, {{today-N}} (each with optional :FORMAT), {{env.NAME}}, and {{lbrace}} for a literal "{{"';

const malformed = (text: string, at: number, why: string): FlowError =>
  new FlowError(
    `malformed template at character ${at} of "${text}": ${why} (${ALLOWED})`,
  );

function expandRef(
  ref: string,
  ctx: TemplateContext,
  text: string,
  open: number,
): string {
  if (ref === 'uid') return ctx.uid;
  if (ref === 'lbrace') return '{{';
  const env = ENV_REF.exec(ref);
  if (env !== null) {
    const name = env[1] ?? '';
    const v = ctx.vars[name];
    if (v === undefined)
      throw new FlowError(
        `unknown env var "${name}" (define it under envs.<env>.vars)`,
      );
    return v;
  }
  const date = DATE_REF.exec(ref);
  if (date === null)
    throw malformed(text, open, `unknown template "{{${ref}}}"`);
  const days = date[2] === undefined ? 0 : Number(date[2]);
  return ctx.now
    .add(date[1] === '-' ? -days : days, 'day')
    .format(date[3] ?? 'YYYY-MM-DD');
}

/**
 * Expands `{{uid}}`, `{{today}}`, `{{today+N}}`, `{{today-N}}` with an optional `:FORMAT`
 * (dayjs format, default `YYYY-MM-DD`), `{{env.NAME}}` from the env's `vars`, and `{{lbrace}}` for a
 * literal `{{`.
 *
 * @remarks One pass: expanded values are never scanned again, so an env var may contain `{{`.
 *   In a run of `{` the last two open the template and the rest are literal, so `{{{uid}}` is
 *   `{` plus the uid; this lets text next to a template round-trip.
 * @throws {FlowError} for an unknown `{{env.NAME}}`, an unknown or malformed `{{...}}`, or a `{{`
 *   with no closing `}}`; the message gives the character offset and the allowed forms.
 * @example expand('Spike {{uid}} {{today+1:DD/MM/YYYY}}', ctx) // 'Spike ab12cd34 06/10/2026'
 * @see docs/adr/0026-template-syntax.md
 */
export function expand(text: string, ctx: TemplateContext): string {
  let out = '';
  let at = 0;
  for (;;) {
    let open = text.indexOf('{{', at);
    if (open < 0) return out + text.slice(at);
    while (text[open + 2] === '{') open++;
    const close = text.indexOf('}}', open + 2);
    const ref = close < 0 ? '' : text.slice(open + 2, close);
    if (close < 0) throw malformed(text, open, 'a "{{" has no closing "}}"');
    if (ref.includes('{{'))
      throw malformed(text, open, 'a template contains another "{{"');
    out += text.slice(at, open) + expandRef(ref.trim(), ctx, text, open);
    at = close + 2;
  }
}

/**
 * Applies `fn` to every string inside `value` (arrays and plain objects are walked).
 *
 * @remarks Deliberately one generic walker: the `as T` casts are confined to this function, which
 *   returns the same shape it receives with only string leaves replaced.
 */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value))
    return value.map((v: unknown) => mapStrings(v, fn)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]),
    ) as T;
  }
  return value;
}

/** Expands templates in every string inside `value` (arrays and plain objects are walked). */
/**
 * A copy of `value` with every secret masked in every string at any depth, object keys kept (issue #13): a System 1
 * request or a log line built from page data then cannot carry a secret in a field nobody thought of.
 */
export function maskDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.every((s) => s === '')) return value;
  return mapStrings(value, (s) => maskSecrets(s, secrets));
}

export function deepExpand<T>(value: T, ctx: TemplateContext): T {
  return mapStrings(value, (s) => expand(s, ctx));
}

const TEMPLATE_SPAN = /(\{\{[^{}]*\}\})/;

/**
 * Turns literal occurrences of the run's `uid` back into `{{uid}}` in every string inside `value`,
 * leaving existing templates as written.
 *
 * @remarks For text the orchestrator wrote, which may mix templates with a uid copied from the
 *   page. Page text (accessible names) goes through the recorder's `templateName` instead.
 */
export function untemplateUid<T>(value: T, uid: string): T {
  if (uid === '') return value;
  return mapStrings(value, (s) =>
    s
      .split(TEMPLATE_SPAN)
      .map((part, i) => (i % 2 === 1 ? part : part.split(uid).join('{{uid}}')))
      .join(''),
  );
}

/**
 * Dry-runs {@link expand} over every string inside `value`, so a malformed template fails when the
 * flow is loaded instead of when it runs. Unknown `{{env.NAME}}` is not an error here: it depends on
 * the env chosen at run time.
 *
 * @param path where `value` sits, prefixed to the error, e.g. `steps[2]`.
 * @throws {FlowError} `<path>: malformed template at character N of "...": ...` with the allowed forms.
 */
export function checkTemplates(value: unknown, path: string): void {
  const ctx: TemplateContext = {
    uid: 'x',
    now: dayjs(),
    vars: new Proxy({}, { get: () => 'x' }),
  };
  if (typeof value === 'string') {
    try {
      expand(value, ctx);
    } catch (e) {
      throw new FlowError(`${path}: ${e instanceof Error ? e.message : e}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v: unknown, i) => checkTemplates(v, `${path}[${i}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value))
      checkTemplates(v, path === '' ? k : `${path}.${k}`);
  }
}

/**
 * Resolves a flow's `inputs` to concrete strings: `{ value }` is template-expanded, `{ env }` is read
 * from the environment.
 *
 * @throws {FlowError} when an `{ env: NAME }` input's variable is not set.
 */
export function resolveInputs(
  inputs: FlowDoc['inputs'],
  ctx: TemplateContext,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, src]) => {
      if ('value' in src) return [key, expand(src.value, ctx)];
      const v = env[src.env];
      if (v === undefined)
        throw new FlowError(
          `input "${key}": environment variable ${src.env} is not set`,
        );
      return [key, v];
    }),
  );
}
