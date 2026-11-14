import { describe, expect, it } from 'vitest';
import {
  checkConsistency,
  contractRef,
  readContracts,
  resolveContractRef,
} from '../../src/derive/index.js';
import type { ContainedRoot } from '../../src/trust/index.js';
import {
  fixtureRoot,
  pick,
  readFiles,
  reasons,
  rootOf,
  valueOf,
} from './contract-fixture.js';

const OPENAPI = `openapi: 3.1.0
paths:
  /a:
    post:
      requestBody: { $ref: '#/components/requestBodies/Shared' }
      responses:
        '400': { description: bad }
  /b:
    post:
      requestBody: { $ref: '#/components/requestBodies/Shared' }
      responses:
        '400': { description: bad }
components:
  requestBodies:
    Shared:
      content:
        application/json:
          schema:
            type: object
            required: [a, b, a]
            properties:
              a: { type: string, maxLength: 5 }
              b: { type: string }
  schemas:
    A:
      type: object
      required: [a, b]
      properties:
        a: { type: string }
        b:
          type: object
          required: [c]
          properties:
            c: { type: array, items: { type: string, maxLength: 3 } }
`;
const CODE = `
const s1 = z.object({ address: z.object({ street: z.string().min(1) }), n: z.string().min(1).min(2) });
const s2 = z.object({ address: z.object({ street: z.string().min(5) }) });
const j1 = Joi.object({ a: Joi.string().min(1) });
const j2 = Joi.object({ a: Joi.string().min(2) });
z.object({ x: z.string() });
Joi.object({ x: Joi.string() });
{ const s1 = z.object({ again: z.string() }); }
`;
const HTML = `<input type="radio" name="kind" required>
<input type="radio" name="kind" required>
<textarea name="note" maxlength="9"></textarea>`;
const FILES = {
  'api/openapi.yaml': OPENAPI,
  'code/schemas.ts': CODE,
  'web/form.html': HTML,
  'locales/en/common.json': '{"a":{"b":"x"},"c":"y"}',
  'locales/vi/common.json': '{"a":{"b":"x"}}',
  'i18n/flat.json': '{"a.b":"1","a":{"b":"2"}}',
};

/** The invariant of ADR 0040: every emitted ref is unique, and resolving it gives exactly that fact. */
function expectStableRefs(root: ContainedRoot): number {
  const { facts } = readContracts(root, { rootName: 'api' });
  const refs = facts.map((f) => contractRef(f, 'api'));
  expect(new Set(refs).size).toBe(refs.length);
  for (const f of facts) {
    const got = resolveContractRef(root, contractRef(f, 'api'), {
      rootName: 'api',
    });
    expect(got?.fact).toEqual(f);
  }
  return facts.length;
}

describe('reference identity', () => {
  it('gives every fact of every format a unique ref that resolves to that fact', () => {
    expect(expectStableRefs(rootOf(FILES))).toBeGreaterThan(30);
    expect(expectStableRefs(fixtureRoot())).toBeGreaterThan(10);
  });

  it('numbers the members of a required array, so one cannot stand for another', () => {
    const { facts } = readFiles({ 'a.yaml': OPENAPI });
    const req = pick(facts, 'b', 'required').filter((f) =>
      f.pointer.endsWith('/required/1'),
    );
    expect(req.map((f) => f.pointer)).toContain(
      '/components/schemas/A/required/1',
    );
    expect(
      facts.some((f) => f.pointer === '/components/schemas/A/required'),
    ).toBe(false);
  });

  it('keeps a nested schema under the variable of its top schema, per schema', () => {
    const { facts } = readFiles({ 'f.ts': CODE });
    const street = pick(facts, 'address.street', 'minLength', 'zod');
    expect(street.map((f) => [f.owner, f.value])).toEqual([
      ['s1', '1'],
      ['s2', '5'],
    ]);
    expect(new Set(street.map((f) => f.pointer)).size).toBe(2);
  });

  it('keeps a repeated rule and a repeated control as separate refs', () => {
    const { facts } = readFiles({ 'f.ts': CODE, 'f.html': HTML });
    expect(pick(facts, 'n', 'minLength').map((f) => f.value)).toEqual([
      '1',
      '2',
    ]);
    expect(pick(facts, 'kind', 'required').map((f) => f.pointer)).toEqual([
      '/input/kind/required',
      '/input/kind#2/required',
    ]);
  });

  it('gives schemas of one file with the same variable or no variable distinct owners', () => {
    const { facts } = readFiles({ 'f.ts': CODE });
    const owners = new Set(facts.map((f) => f.owner));
    expect(owners.has('s1@2')).toBe(true);
    expect(pick(facts, 'x', 'type').map((f) => f.owner)).toHaveLength(2);
    expect(new Set(pick(facts, 'x', 'type').map((f) => f.owner)).size).toBe(2);
  });

  it('reports a later fact with a ref already taken as ambiguous_ref, never as a second fact', () => {
    const { facts, skipped } = readFiles({ 'a.yaml': OPENAPI });
    expect(reasons(skipped)).toContain('ambiguous_ref');
    const refs = facts.map((f) => contractRef(f, 'api'));
    expect(new Set(refs).size).toBe(refs.length);
  });
});

describe('locales, textareas and nested schemas', () => {
  it('takes the locale of locales/<lang>/<namespace>.json from the folder and reports a key one language lacks', () => {
    const { facts } = readFiles({
      'locales/en/common.json': '{"request":{"reason":"x"}}',
      'locales/vi/common.json': '{"other":"y"}',
      'form.ts': "z.object({ r: z.string().min(1, 'request.reason') });",
    });
    expect(
      new Set(facts.filter((f) => f.source === 'i18n').map((f) => f.owner)),
    ).toEqual(new Set(['en', 'vi']));
    const checks = checkConsistency({ facts }).filter(
      (c) => c.kind === 'message_i18n',
    );
    expect(checks.map((c) => [c.locale, c.outcome])).toEqual([
      ['en', 'equal'],
      ['vi', 'missing'],
    ]);
  });

  it('reads a textarea as a control and its body as text', () => {
    const { facts } = readFiles({
      'p.html':
        '<textarea name="a" maxlength="9">&lt;input name="x" required></textarea><input name="y" required>',
    });
    expect(valueOf(facts, 'a', 'maxLength')).toBe('9');
    expect(pick(facts, 'x', 'required')).toEqual([]);
    expect(valueOf(facts, 'y', 'required')).toBe('true');
  });

  it('reads z.array(z.object), .extend and .keys, and reports what it cannot read with the line', () => {
    const { facts, skipped } = readFiles({
      'a.ts': [
        'const s = z.object({ items: z.array(z.object({ qty: z.number().min(1) })) })',
        '  .extend({ more: z.string().max(4) });',
        'const j = Joi.object({ a: Joi.string() }).keys({ b: Joi.string().max(7) });',
        'const u = z.object({ p: z.union([z.object({ q: z.string() }), z.string()]) });',
        'const m = z.object({ a: z.string() }).merge(other);',
      ].join('\n'),
    });
    expect(valueOf(facts, 'items.qty', 'min')).toBe('1');
    expect(valueOf(facts, 'more', 'maxLength')).toBe('4');
    expect(valueOf(facts, 'b', 'maxLength')).toBe('7');
    expect(skipped.map((s) => [s.file, s.line, s.reason])).toEqual(
      expect.arrayContaining([
        ['a.ts', 4, 'nested_schema_unread'],
        ['a.ts', 5, 'schema_extension_unread'],
      ]),
    );
  });
});

describe('what a contract may say', () => {
  it('skips a quoted number or boolean in an OpenAPI document', () => {
    const { facts, skipped } = readFiles({
      'a.yaml':
        'openapi: 3.1.0\ncomponents:\n  schemas:\n    A:\n      properties:\n        f: { type: string, maxLength: "10", minLength: 2 }\n',
    });
    expect(pick(facts, 'f', 'maxLength')).toEqual([]);
    expect(valueOf(facts, 'f', 'minLength')).toBe('2');
    expect(reasons(skipped)).toEqual(['ambiguous_number']);
    const q = readFiles({
      'b.yaml':
        'openapi: 3.1.0\npaths:\n  /a:\n    get:\n      parameters:\n        - { name: q, in: query, required: "true" }\n',
    });
    expect(pick(q.facts, 'q', 'required')).toEqual([]);
    expect(reasons(q.skipped)).toEqual(['quoted_boolean']);
  });

  it('skips a value or file name with an invisible character, and shows the name escaped', () => {
    const bidi = readFiles({
      'a.yaml':
        'openapi: 3.1.0\ncomponents:\n  schemas:\n    A:\n      properties:\n        f: { type: string, pattern: "a\u202eb" }\n',
      'a\u202eb.html': '<input name="x" maxlength="3">',
    });
    expect(pick(bidi.facts, 'f', 'pattern')).toEqual([]);
    expect(bidi.facts.some((f) => f.file.includes('\u202e'))).toBe(false);
    expect(bidi.skipped.some((s) => s.file.includes('\u202e'))).toBe(false);
    expect(reasons(bidi.skipped)).toEqual(
      expect.arrayContaining(['fact_unsafe']),
    );
  });

  it('uses every request property name, not only typed ones, for a response field check', () => {
    const { facts } = readFiles({
      'a.yaml': `openapi: 3.1.0
paths:
  /a:
    post:
      requestBody:
        content:
          application/json:
            schema:
              properties:
                c: { $ref: '#/components/schemas/C' }
      responses:
        '400':
          content:
            application/json: { schema: { $ref: '#/components/schemas/Err' } }
components:
  schemas:
    C: { type: string }
    Err:
      properties:
        field: { type: string, enum: [c] }
`,
    });
    const c = checkConsistency({ facts }).filter(
      (x) => x.kind === 'response_schema',
    );
    expect(c.map((x) => [x.field, x.outcome])).toEqual([['c', 'equal']]);
  });
});
