import { describe, expect, it } from 'vitest';
import { pick, readFiles, reasons, valueOf } from './contract-fixture.js';

const ZOD = `
import { z } from 'zod';
export const leaveForm = z.object({
  reason: z.string().min(1, 'request.reason.required').max(200, { message: 'request.reason.tooLong' }),
  amount: z.number().int().min(0, 'request.amount.invalid').max(1e9),
  type: z.enum(['LEAVE', 'SICK']),
  code: z.string().regex(/^[A-Z]{3}$/),
  note: z.string().optional(),
  status: z.literal('NEW'),
});
`;

const JOI = `
const Joi = require('joi');
const schema = Joi.object({
  reason: Joi.string().required().max(200).messages({ 'string.max': 'request.reason.tooLong', 'any.required': 'request.reason.required' }),
  amount: Joi.number().min(0).max(1000000000),
  type: Joi.string().valid('LEAVE', 'SICK'),
  code: Joi.string().pattern(/^[A-Z]{3}$/),
});
`;

describe('zod schemas', () => {
  const { facts, skipped } = readFiles({ 'src/form.ts': ZOD });
  const zod = facts.filter((f) => f.source === 'zod');

  it('reads min, max, enum, regex and literal with the literal values', () => {
    expect(valueOf(zod, 'reason', 'minLength')).toBe('1');
    expect(valueOf(zod, 'reason', 'maxLength')).toBe('200');
    expect(valueOf(zod, 'amount', 'min')).toBe('0');
    expect(valueOf(zod, 'amount', 'max')).toBe('1000000000');
    expect(valueOf(zod, 'type', 'enum')).toBe('["LEAVE","SICK"]');
    expect(valueOf(zod, 'code', 'pattern')).toBe('^[A-Z]{3}$');
    expect(valueOf(zod, 'status', 'enum')).toBe('["NEW"]');
  });

  it('reads messages given as a string or as an object', () => {
    expect(pick(zod, 'reason', 'minLength')[0]?.messageKey).toBe(
      'request.reason.required',
    );
    expect(pick(zod, 'reason', 'maxLength')[0]?.messageKey).toBe(
      'request.reason.tooLong',
    );
  });

  it('marks a key required unless it is optional, with the variable name as owner and the client side', () => {
    expect(pick(zod, 'reason', 'required')).toHaveLength(1);
    expect(pick(zod, 'note', 'required')).toHaveLength(0);
    expect(zod[0]).toMatchObject({
      owner: 'leaveForm',
      side: 'client',
      file: 'src/form.ts',
    });
    expect(pick(zod, 'reason', 'maxLength')[0]?.pointer).toBe(
      '/leaveForm/reason/maxLength',
    );
    expect(pick(zod, 'reason', 'maxLength')[0]?.line).toBe(4);
    expect(skipped).toEqual([]);
  });
});

describe('Joi schemas', () => {
  const { facts, skipped } = readFiles({ 'api/leave.validation.ts': JOI });
  const joi = facts.filter((f) => f.source === 'joi');

  it('reads required, max, min, valid and pattern, on the server side', () => {
    expect(valueOf(joi, 'reason', 'required')).toBe('true');
    expect(valueOf(joi, 'reason', 'maxLength')).toBe('200');
    expect(valueOf(joi, 'amount', 'min')).toBe('0');
    expect(valueOf(joi, 'amount', 'max')).toBe('1000000000');
    expect(valueOf(joi, 'type', 'enum')).toBe('["LEAVE","SICK"]');
    expect(valueOf(joi, 'code', 'pattern')).toBe('^[A-Z]{3}$');
    expect(joi[0]?.side).toBe('server');
  });

  it('attaches the text of messages() to the rule its code names', () => {
    expect(pick(joi, 'reason', 'maxLength')[0]?.messageKey).toBe(
      'request.reason.tooLong',
    );
    expect(pick(joi, 'reason', 'required')[0]?.messageKey).toBe(
      'request.reason.required',
    );
    expect(skipped).toEqual([]);
  });
});

describe('what the readers do not understand', () => {
  it('reports each unsupported construct with its line and makes no fact from it', () => {
    const src = [
      'const base = z.object({ a: z.string() });',
      'export const s = z.object({',
      '  ...base.shape,',
      '  [key]: z.string(),',
      '  imported: importedSchema,',
      '  shorthand,',
      '  viaVariable: z.string().min(LIMIT),',
      '  tpl: z.string().max(`${n}`),',
      '  odd: z.string().superTrim().max(5),',
      '});',
    ].join('\n');
    const { facts, skipped } = readFiles({ 'a.ts': src });
    expect(skipped.map((s) => [s.reason, s.line])).toEqual([
      ['spread', 3],
      ['unsupported_entry', 4],
      ['not_a_literal_schema', 5],
      ['unsupported_entry', 6],
      ['non_literal_argument', 7],
      ['non_literal_argument', 8],
      ['unsupported_method:superTrim', 9],
    ]);
    expect(pick(facts, 'viaVariable', 'minLength')).toEqual([]);
    expect(valueOf(facts, 'odd', 'maxLength')).toBe('5');
  });

  it('reads nothing from an imported or composed schema and does not guess a number from a variable', () => {
    const { facts } = readFiles({
      'a.ts':
        'const S = makeSchema(z); export const T = S.extend({ a: z.string().max(3) });\n',
    });
    expect(facts).toEqual([]);
  });

  it('refuses ambiguous numbers instead of reading them', () => {
    const { facts, skipped } = readFiles({
      'a.ts':
        'export const s = z.object({ a: z.number().min(0x10).max(1_000) });\n',
    });
    expect(pick(facts, 'a', 'min')).toEqual([]);
    expect(pick(facts, 'a', 'max')).toEqual([]);
    expect(reasons(skipped)).toEqual([
      'non_literal_argument',
      'non_literal_argument',
    ]);
  });

  it('reads a negative number and a nested object', () => {
    const { facts } = readFiles({
      'a.ts':
        'export const s = z.object({ t: z.number().min(-5), addr: z.object({ zip: z.string().max(5) }) });\n',
    });
    expect(valueOf(facts, 't', 'min')).toBe('-5');
    expect(valueOf(facts, 'addr.zip', 'maxLength')).toBe('5');
  });
});
