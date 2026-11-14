import {
  argOf,
  type ChainReader,
  type ChainRule,
  enumValue,
} from './validators.js';
import type { Arg } from './js-chain.js';

const IGNORED = new Set([
  'trim',
  'lowercase',
  'uppercase',
  'label',
  'description',
  'default',
  'optional',
  'allow',
  'integer',
  'positive',
  'negative',
  'email',
  'uri',
  'uuid',
  'alphanum',
  'strict',
  'convert',
  'items',
  'object',
  'keys',
  'unknown',
  'example',
]);
const TYPES = new Set([
  'string',
  'number',
  'boolean',
  'date',
  'array',
  'object',
  'any',
  'valid',
]);
const CODES: Readonly<Record<string, ChainRule['rule']>> = {
  'string.min': 'minLength',
  'string.max': 'maxLength',
  'any.required': 'required',
  'number.min': 'min',
  'number.max': 'max',
  'string.pattern.base': 'pattern',
  'any.only': 'enum',
};

/**
 * Reads a Joi chain (`Joi.string().min(1).max(200).required().messages({ 'string.max': 'key' })`) by shape: the
 * type, `min`/`max` (`minLength`/`maxLength` on a string, `min`/`max` on a number), `required`, `pattern`/`regex`,
 * `valid` (an enum of literals) and `messages`, whose codes (`string.max`, `any.required`, ...) attach their text
 * to the rule they belong to. A method it does not know, or a non-literal argument, is a skip with its line.
 *
 * @see docs/adr/0040-contract-readers.md
 */
export const readJoiChain: ChainReader = (chain, skip) => {
  const rules: ChainRule[] = [];
  const first = chain.calls[0];
  if (first === undefined || !TYPES.has(first.name)) {
    skip('unsupported_chain', first?.line ?? 0);
    return rules;
  }
  const type =
    first.name === 'string'
      ? 'string'
      : first.name === 'number'
        ? 'number'
        : undefined;
  if (first.name !== 'valid')
    rules.push({ rule: 'type', value: first.name, line: first.line });
  let messages: ReadonlyMap<string, Arg> | undefined;
  for (const call of chain.calls) {
    const n = argOf(call, 0, 'num');
    if (call.name === 'required')
      rules.push({ rule: 'required', value: 'true', line: call.line });
    else if (call.name === 'valid') {
      const items = call.args.flatMap((a) =>
        a.kind === 'str' || a.kind === 'num' ? [a.value] : [],
      );
      if (items.length !== call.args.length || items.length === 0)
        skip('non_literal_argument', call.line);
      else
        rules.push({ rule: 'enum', value: enumValue(items), line: call.line });
    } else if (call.name === 'min' || call.name === 'max') {
      if (n === undefined) skip('non_literal_argument', call.line);
      else if (type === undefined) skip('type_unknown', call.line);
      else {
        const isMin = call.name === 'min';
        rules.push({
          rule:
            type === 'string'
              ? isMin
                ? 'minLength'
                : 'maxLength'
              : isMin
                ? 'min'
                : 'max',
          value: n.value,
          line: call.line,
        });
      }
    } else if (call.name === 'pattern' || call.name === 'regex') {
      const re = argOf(call, 0, 'regex');
      if (re === undefined) skip('non_literal_argument', call.line);
      else rules.push({ rule: 'pattern', value: re.value, line: call.line });
    } else if (call.name === 'messages') {
      const o = argOf(call, 0, 'object');
      if (o === undefined) skip('non_literal_argument', call.line);
      else messages = o.props;
    } else if (call !== first && !IGNORED.has(call.name))
      skip(`unsupported_method:${call.name.slice(0, 40)}`, call.line);
  }
  return rules.map((r) => {
    const key = Object.entries(CODES).find(([, rule]) => rule === r.rule)?.[0];
    const m = key === undefined ? undefined : messages?.get(key);
    return m?.kind === 'str' ? { ...r, messageKey: m.value } : r;
  });
};
