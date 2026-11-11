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

/** A validator call whose `(` is open: its method, the argument positions that count, the bracket depth inside it. */
interface OpenCall {
  method: string;
  args: readonly number[] | null;
  depth: number;
  arg: number;
}

const OPEN = new Set(['(', '[', '{']);
const CLOSE = new Set([')', ']', '}']);

/**
 * The validator message literals in the source of `rel`, in source order: string arguments of validator method
 * calls (`.min(1, 'msg')`, `.required('msg')`, yup `.test(name, 'msg', fn)`) and string values of message keys
 * (`{ message: 'msg' }`, `required_error`, react-hook-form `required: 'msg'`). Only a file that imports a
 * validation or form library is read, so `toast({ message })` elsewhere is not a validator message.
 *
 * @remarks One pass over the tokens with a stack of the validator calls that are open, so a chain of nested calls
 *   stays linear: a string counts when it is a whole argument directly inside the innermost open bracket and that
 *   bracket is a validator call's.
 */
export function messagesInSource(
  rel: string,
  text: string,
  toks: () => readonly Token[] = () => lex(text),
): MessageRecord[] {
  if (!VALIDATION_IMPORT.test(text)) return [];
  const all = toks();
  const out: MessageRecord[] = [];
  const calls: OpenCall[] = [];
  let depth = 0;
  for (let i = 0; i < all.length; i++) {
    const t = all[i];
    if (t === undefined) break;
    const prev = all[i - 1];
    const next = all[i + 1];
    const call = calls.at(-1);
    const inCall = call !== undefined && call.depth === depth;
    if (OPEN.has(t.value) && t.type === 'punct') {
      depth++;
      const args = prev === undefined ? undefined : METHODS.get(prev.value);
      if (
        t.value === '(' &&
        args !== undefined &&
        prev?.type === 'id' &&
        all[i - 2]?.value === '.'
      )
        calls.push({ method: prev.value, args, depth, arg: 0 });
    } else if (CLOSE.has(t.value) && t.type === 'punct') {
      if (inCall) calls.pop();
      depth--;
    } else if (inCall && t.value === ',' && t.type === 'punct') call.arg++;
    else if (
      inCall &&
      t.type === 'str' &&
      [',', '('].includes(prev?.value ?? '') &&
      [',', ')'].includes(next?.value ?? '') &&
      (call.args === null || call.args.includes(call.arg))
    )
      out.push({
        file: rel,
        line: t.line,
        text: t.value,
        via: `${call.method}()`,
      });
    else if (
      (t.type === 'id' || t.type === 'str') &&
      next?.value === ':' &&
      MESSAGE_KEYS.has(t.value)
    ) {
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
