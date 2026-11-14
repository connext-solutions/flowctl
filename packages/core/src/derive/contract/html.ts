import { type Emitter, pointerOf, shortName } from './emit.js';
import { canonicalNumber } from './numbers.js';
import type { ContractLimits, ContractRule } from './types.js';

const CONTROLS = new Set(['input', 'textarea', 'select']);
const RULES: readonly (readonly [string, ContractRule])[] = [
  ['required', 'required'],
  ['minlength', 'minLength'],
  ['maxlength', 'maxLength'],
  ['min', 'min'],
  ['max', 'max'],
  ['pattern', 'pattern'],
];
const TAG = /<([A-Za-z][A-Za-z0-9-]*)/y;
const ATTR_NAME = /[^\s"'<>/=]+/y;
const UNQUOTED = /[^\s"'=<>`]+/y;
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const NUMERIC: ReadonlySet<ContractRule> = new Set([
  'minLength',
  'maxLength',
  'min',
  'max',
]);
const WHOLE = /^\d+$/;

/** The canonical form of a numeric attribute, or `undefined` when the text is not one (ADR 0040 rule 4). */
function attributeNumber(rule: ContractRule, raw: string): string | undefined {
  const n = canonicalNumber(raw, 'data');
  if (rule === 'minLength' || rule === 'maxLength')
    return n !== undefined && WHOLE.test(n) ? n : undefined;
  return n ?? (DATE.test(raw) ? raw : undefined);
}

/**
 * Reads the constraint attributes of the form controls of an HTML text: `required`, `minlength`, `maxlength`,
 * `min`, `max` and `pattern` of every `input`, `textarea` and `select` start tag, by control name (`name`, else
 * `id`). A scanner of start tags only, not an HTML parser: comments, `<script>` and `<style>` bodies are skipped, so
 * nothing inside them counts; attribute names are lower-cased, values are raw (no entity decoding); the first of a
 * duplicated attribute wins and the repeat is a skip; a numeric attribute is read as a canonical number (`min="0"`; a
 * `YYYY-MM-DD` date is kept as written) and anything else (`maxlength="0200"`) is an `ambiguous_number` skip; a
 * control name repeated in one file gets `#2`, `#3` in its pointer, so every reference is unique. Tags and attributes per tag are capped; an unclosed tag at the
 * end of the text is a skip.
 *
 * @see docs/adr/0040-contract-readers.md
 */
export function htmlFacts(
  text: string,
  out: Emitter,
  lim: ContractLimits,
): void {
  let i = 0;
  let line = 1;
  let tags = 0;
  const seen = new Map<string, number>();
  const used = new Set<string>();
  const lineAt = (to: number): number => {
    for (; i < to; i++) if (text[i] === '\n') line++;
    return line;
  };
  let at = 0;
  const lower = text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  while (at < text.length) {
    const lt = text.indexOf('<', at);
    if (lt < 0) return;
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      at = end < 0 ? text.length : end + 3;
      continue;
    }
    TAG.lastIndex = lt;
    const m = TAG.exec(text);
    if (m === null) {
      at = lt + 1;
      continue;
    }
    const name = (m[1] ?? '').toLowerCase();
    if (++tags > lim.maxTags) return out.skip('too_many_tags', lineAt(lt));
    const parsed = attributes(text, TAG.lastIndex, lim.maxAttributes);
    if (parsed === undefined) return out.skip('unclosed_tag', lineAt(lt));
    at = parsed.end;
    if (RAW_TEXT.has(name)) {
      const close = lower.indexOf(`</${name}`, parsed.end);
      at = close < 0 ? text.length : close;
    }
    if (!CONTROLS.has(name)) continue;
    const here = lineAt(lt);
    if (parsed.overflow) out.skip('too_many_attributes', here);
    for (const dup of parsed.duplicates)
      out.skip(`duplicate_attribute:${shortName(dup)}`, here);
    const control = parsed.attrs.get('name') ?? parsed.attrs.get('id');
    if (control === undefined || control === '') continue;
    const named = uniqueControl(name, control, seen, used);
    for (const [attr, rule] of RULES) {
      const raw = parsed.attrs.get(attr);
      if (raw === undefined) continue;
      const numeric = NUMERIC.has(rule);
      const num = numeric ? attributeNumber(rule, raw) : undefined;
      if (numeric && num === undefined) {
        out.skip('ambiguous_number', here);
        continue;
      }
      out.fact({
        line: here,
        pointer: pointerOf([name, named, attr]),
        owner: name,
        field: control,
        rule,
        value: rule === 'required' ? 'true' : (num ?? raw),
      });
    }
  }
}

/**
 * The name a control carries in its pointer: `control`, then `control#2`, `control#3` for the repeats of one tag and
 * name. A repeat is numbered past any name the file already uses (a control literally called `a#2`), so no two
 * controls share a name. `seen` counts the repeats of a name, so each control costs one step plus the names it skips.
 */
function uniqueControl(
  tag: string,
  control: string,
  seen: Map<string, number>,
  used: Set<string>,
): string {
  const key = `${tag}\0${control}`;
  let nth = seen.get(key) ?? 0;
  let named: string;
  do {
    nth++;
    named = nth === 1 ? control : `${control}#${nth}`;
  } while (used.has(`${tag}\0${named}`));
  seen.set(key, nth);
  used.add(`${tag}\0${named}`);
  return named;
}

interface Attrs {
  attrs: Map<string, string>;
  duplicates: string[];
  overflow: boolean;
  end: number;
}

/** The attributes of the start tag whose name ends at `from`, or `undefined` when the text ends first. */
function attributes(
  text: string,
  from: number,
  max: number,
): Attrs | undefined {
  const attrs = new Map<string, string>();
  const duplicates: string[] = [];
  let overflow = false;
  let i = from;
  let seen = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '>') return { attrs, duplicates, overflow, end: i + 1 };
    if (c === undefined || /[\s/]/.test(c)) {
      i++;
      continue;
    }
    ATTR_NAME.lastIndex = i;
    const n = ATTR_NAME.exec(text);
    if (n === null) {
      i++;
      continue;
    }
    i = ATTR_NAME.lastIndex;
    let value = '';
    let j = i;
    while (j < text.length && /\s/.test(text[j] ?? '')) j++;
    if (text[j] === '=') {
      j++;
      while (j < text.length && /\s/.test(text[j] ?? '')) j++;
      const q = text[j];
      if (q === '"' || q === "'") {
        const end = text.indexOf(q, j + 1);
        if (end < 0) return undefined;
        value = text.slice(j + 1, end);
        i = end + 1;
      } else {
        UNQUOTED.lastIndex = j;
        const u = UNQUOTED.exec(text);
        value = u?.[0] ?? '';
        i = u === null ? j : UNQUOTED.lastIndex;
      }
    }
    if (++seen > max) {
      overflow = true;
      continue;
    }
    const key = n[0].toLowerCase();
    if (attrs.has(key)) duplicates.push(key);
    else attrs.set(key, value);
  }
  return undefined;
}
