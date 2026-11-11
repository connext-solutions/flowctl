import { lex, type Token } from './lexer.js';
import type { MessageRecord } from './types.js';

/** An import of a validation or form library; a file without one is not read for messages. */
const VALIDATION_IMPORT =
  /(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*|\bimport\s+)['"](?:zod|yup|joi|valibot|superstruct|vee-validate|react-hook-form|@angular\/forms|class-validator|@hookform\/[\w-]+|@vuelidate\/[\w-]+|@tanstack\/[\w-]*form)(?:\/[\w./-]*)?['"]/;

/**
 * Validator methods whose string arguments are messages, with the argument positions that count (`null`: any);
 * yup's `test(name, message, fn)` names the test first.
 */
const METHODS: ReadonlyMap<string, readonly number[] | null> = new Map<
  string,
  readonly number[] | null
>([
  ...[
    'required',
    'min',
    'max',
    'length',
    'email',
    'url',
    'uuid',
    'regex',
    'matches',
    'nonempty',
    'positive',
    'negative',
    'nonnegative',
    'integer',
    'int',
    'lessThan',
    'moreThan',
    'refine',
    'typeError',
    'startsWith',
    'endsWith',
    'includes',
    'trim',
    'lowercase',
    'uppercase',
  ].map((m): [string, null] => [m, null]),
  ['test', [1]],
]);

/** Object keys whose string value is a message (`{ message: '…' }`, zod `required_error`, react-hook-form `required`). */
const MESSAGE_KEYS = new Set([
  'message',
  'required',
  'required_error',
  'invalid_type_error',
  'errorMessage',
]);

/** Most tokens one call's arguments are scanned for, so nested calls cannot make the scan quadratic. */
const MAX_CALL_TOKENS = 2_000;

/** The direct string arguments of the call whose `(` is at `open`, with their positions. */
function callStrings(
  toks: readonly Token[],
  open: number,
): { tok: Token; arg: number }[] {
  const out: { tok: Token; arg: number }[] = [];
  let depth = 0;
  let arg = 0;
  const stop = Math.min(toks.length, open + MAX_CALL_TOKENS);
  for (let k = open; k < stop; k++) {
    const t = toks[k];
    if (t === undefined) break;
    if (t.value === '(' || t.value === '[' || t.value === '{') depth++;
    else if (t.value === ')' || t.value === ']' || t.value === '}') {
      if (--depth === 0) break;
    } else if (depth === 1 && t.value === ',') arg++;
    else if (
      depth === 1 &&
      t.type === 'str' &&
      [',', '('].includes(toks[k - 1]?.value ?? '') &&
      [',', ')'].includes(toks[k + 1]?.value ?? '')
    )
      out.push({ tok: t, arg });
  }
  return out;
}

/**
 * The validator message literals in the source of `rel`, in source order: string arguments of validator method
 * calls (`.min(1, 'msg')`, `.required('msg')`, yup `.test(name, 'msg', fn)`) and string values of message keys
 * (`{ message: 'msg' }`, `required_error`, react-hook-form `required: 'msg'`). Only a file that imports a
 * validation or form library is read, so `toast({ message })` elsewhere is not a validator message.
 *
 * @remarks A call's arguments are scanned for at most 2,000 tokens, so a chain of nested calls stays linear.
 */
export function messagesInSource(
  rel: string,
  text: string,
  toks: () => readonly Token[] = () => lex(text),
): MessageRecord[] {
  if (!VALIDATION_IMPORT.test(text)) return [];
  const all = toks();
  const out: MessageRecord[] = [];
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t?.type !== 'id' && t?.type !== 'str') continue;
    const next = all[i + 1];
    if (t.type === 'id' && all[i - 1]?.value === '.' && next?.value === '(') {
      const args = METHODS.get(t.value);
      if (args === undefined) continue;
      for (const { tok, arg } of callStrings(all, i + 1))
        if (args === null || args.includes(arg))
          out.push({
            file: rel,
            line: tok.line,
            text: tok.value,
            via: `${t.value}()`,
          });
    } else if (next?.value === ':' && MESSAGE_KEYS.has(t.value)) {
      const v = all[i + 2];
      const after = all[i + 3]?.value ?? '';
      if (v?.type === 'str' && [',', '}'].includes(after))
        out.push({
          file: rel,
          line: v.line,
          text: v.value,
          via: `${t.value}:`,
        });
    }
  }
  return out;
}
