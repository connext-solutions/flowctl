import { shortName } from './emit.js';
import {
  argOf,
  type ChainReader,
  type ChainRule,
  enumValue,
  messageAt,
} from './validators.js';

const OPTIONAL = new Set(['optional', 'nullish', 'default', 'catch']);
const IGNORED = new Set([
  'trim',
  'toLowerCase',
  'toUpperCase',
  'describe',
  'int',
  'finite',
  'safe',
  'strict',
  'passthrough',
  'strip',
  'brand',
  'readonly',
  'nullable',
  'email',
  'url',
  'uuid',
  'cuid',
  'datetime',
  'positive',
  'negative',
  'nonnegative',
  'nonpositive',
  'coerce',
  'object',
  'array',
  'refine',
  'superRefine',
  'transform',
  'pipe',
  'or',
  'and',
]);
const TYPES = new Set([
  'string',
  'number',
  'bigint',
  'boolean',
  'date',
  'enum',
  'literal',
  'array',
  'object',
  'any',
]);

/**
 * Reads a zod chain (`z.string().min(1, 'key').max(200).regex(/re/).optional()`) by shape: the type, `min`/`max`
 * (`minLength`/`maxLength` on a string, `min`/`max` on a number; `gte`/`lte` and `nonempty` and `length` too),
 * `regex`, `enum` and `literal`, and `required` for a key that is not `optional`, `nullish`, `default` or `catch`.
 * A message is a string argument or `{ message }`. A method it does not know is a skip with its line; a
 * non-literal argument too. Nothing is evaluated.
 *
 * @see docs/adr/0040-contract-readers.md
 */
export const readZodChain: ChainReader = (chain, skip) => {
  const rules: ChainRule[] = [];
  const calls = chain.calls.filter((c) => c.name !== 'coerce');
  const first = calls[0];
  if (first === undefined || !TYPES.has(first.name)) {
    skip('unsupported_chain', first?.line ?? 0);
    return rules;
  }
  const type =
    first.name === 'string'
      ? 'string'
      : first.name === 'number' || first.name === 'bigint'
        ? 'number'
        : undefined;
  rules.push({ rule: 'type', value: first.name, line: first.line });
  let optional = false;
  for (const call of calls) {
    const n = argOf(call, 0, 'num');
    const message = messageAt(call, call.name === 'nonempty' ? 0 : 1);
    const add = (rule: ChainRule['rule'], value: string): void => {
      rules.push({
        rule,
        value,
        line: call.line,
        ...(message === undefined ? {} : { messageKey: message }),
      });
    };
    if (call === first) {
      const list = argOf(call, 0, 'list');
      const one = argOf(call, 0, 'str') ?? argOf(call, 0, 'num');
      if (call.name === 'enum' && list !== undefined)
        add('enum', enumValue(list.items));
      else if (call.name === 'literal' && one !== undefined)
        add('enum', enumValue([one.value]));
      else if (call.name === 'enum' || call.name === 'literal')
        skip('non_literal_argument', call.line);
      continue;
    }
    if (OPTIONAL.has(call.name)) optional = true;
    else if (['min', 'max', 'gte', 'lte', 'length'].includes(call.name)) {
      if (n === undefined) skip('non_literal_argument', call.line);
      else if (type === undefined) skip('type_unknown', call.line);
      else if (call.name === 'length' && type === 'string') {
        add('minLength', n.value);
        add('maxLength', n.value);
      } else if (call.name === 'length')
        skip('unsupported_method:length', call.line);
      else if (
        type === 'string' &&
        (call.name === 'gte' || call.name === 'lte')
      )
        skip(`unsupported_method:${call.name}`, call.line);
      else {
        const isMin = call.name === 'min' || call.name === 'gte';
        add(
          type === 'string'
            ? isMin
              ? 'minLength'
              : 'maxLength'
            : isMin
              ? 'min'
              : 'max',
          n.value,
        );
      }
    } else if (call.name === 'nonempty') add('minLength', '1');
    else if (call.name === 'regex') {
      const re = argOf(call, 0, 'regex');
      if (re === undefined) skip('non_literal_argument', call.line);
      else add('pattern', re.value);
    } else if (!IGNORED.has(call.name))
      skip(`unsupported_method:${shortName(call.name)}`, call.line);
  }
  if (!optional && first.name !== 'object')
    rules.push({ rule: 'required', value: 'true', line: first.line });
  return rules;
};
