import { describe, expect, it } from 'vitest';
import {
  contractRef,
  readContracts,
  resolveContractRef,
} from '../../src/derive/index.js';
import { Emitter, shared } from '../../src/derive/contract/emit.js';
import { CONTRACT_LIMITS } from '../../src/derive/contract/types.js';
import type { ContainedRoot } from '../../src/trust/index.js';
import {
  pick,
  readFiles,
  reasons,
  rootOf,
  valueOf,
} from './contract-fixture.js';

const MIB = 1024 * 1024;
const LIMIT_MS = 2000;

const SHARED = `openapi: 3.1.0
paths:
  /x:
    post:
      parameters:
        - { $ref: '#/components/parameters/Q' }
      requestBody: { $ref: '#/components/requestBodies/Body' }
      responses:
        '400': { $ref: '#/components/responses/Bad' }
  /y:
    post:
      parameters:
        - { $ref: '#/components/parameters/Q' }
      requestBody: { $ref: '#/components/requestBodies/Body' }
      responses:
        '400': { $ref: '#/components/responses/Bad' }
components:
  parameters:
    Q: { name: q, in: query, required: true, schema: { type: string, maxLength: 5 } }
  requestBodies:
    Body:
      content:
        application/json:
          schema:
            properties:
              reason: { type: string, maxLength: 9 }
  responses:
    Bad:
      content:
        application/json:
          schema:
            properties:
              field: { type: string, enum: [a, b] }
`;

/** Every ref is unique and resolves to its own fact. */
function expectStable(root: ContainedRoot): void {
  const { facts } = readContracts(root, { rootName: 'api' });
  const refs = facts.map((f) => contractRef(f, 'api'));
  expect(new Set(refs).size).toBe(refs.length);
  for (const f of facts)
    expect(
      resolveContractRef(root, contractRef(f, 'api'), { rootName: 'api' })
        ?.fact,
    ).toEqual(f);
}

describe('a component shared by two operations', () => {
  it('gives each operation its own facts, with unique refs that resolve to the real value', () => {
    const root = rootOf({ 'a.yaml': SHARED });
    const { facts, skipped } = readContracts(root, { rootName: 'api' });
    expect(reasons(skipped)).toEqual([]);
    for (const owner of ['POST /x', 'POST /y']) {
      const mine = facts.filter((f) => f.owner.startsWith(owner));
      expect(mine.some((f) => f.field === 'q' && f.rule === 'required')).toBe(
        true,
      );
      expect(mine.some((f) => f.field === 'q' && f.rule === 'maxLength')).toBe(
        true,
      );
      expect(
        mine.some((f) => f.field === 'reason' && f.rule === 'maxLength'),
      ).toBe(true);
      expect(mine.some((f) => f.field === 'field' && f.rule === 'enum')).toBe(
        true,
      );
    }
    expectStable(root);
  });
});

describe('a key written twice', () => {
  it('reads only the last one, in an object literal and in an extend', () => {
    const { facts } = readFiles({
      'a.ts': [
        'const s = z.object({ a: z.string().min(1) }).extend({ a: z.string().min(5) });',
        'const t = z.object({ a: z.string().min(1), a: z.string().min(9) });',
        'const u = z.object({ a: z.string().min(1) }).extend({ a: other });',
      ].join('\n'),
    });
    expect(
      facts
        .filter((f) => f.owner === 's' && f.rule === 'minLength')
        .map((f) => f.value),
    ).toEqual(['5']);
    expect(
      facts
        .filter((f) => f.owner === 't' && f.rule === 'minLength')
        .map((f) => f.value),
    ).toEqual(['9']);
    expect(facts.filter((f) => f.owner === 'u')).toEqual([]);
  });
});

describe('owners and control names are unique across a whole file', () => {
  it('keeps zod and Joi schemas with the same variable name', () => {
    const { facts } = readFiles({
      'a.ts':
        'const schema1 = z.object({a: z.string().min(1)}); Joi.object({a: Joi.string().min(1)});\nconst s = z.object({a: z.string().min(2)});\nconst s = Joi.object({a: Joi.string().min(3)});',
    });
    expect(pick(facts, 'a', 'minLength', 'joi').map((f) => f.value)).toEqual([
      '1',
      '3',
    ]);
    expect(pick(facts, 'a', 'minLength', 'zod').map((f) => f.value)).toEqual([
      '1',
      '2',
    ]);
    expect(valueOf(facts, 'a', 'minLength', 'joi')).toBeUndefined();
    const owners = facts.map((f) => `${f.source}${f.owner}`);
    expect(new Set(owners.map((o, i) => `${o}${facts[i]?.pointer}`)).size).toBe(
      facts.length,
    );
  });

  it('keeps a control literally named like a suffixed repeat', () => {
    const { facts, skipped } = readFiles({
      'f.html':
        '<input name="a" required><input name="a" required><input name="a#2" required>',
    });
    expect(pick(facts, 'a', 'required')).toHaveLength(2);
    expect(pick(facts, 'a#2', 'required')).toHaveLength(1);
    expect(reasons(skipped)).toEqual([]);
    expect(new Set(facts.map((f) => f.pointer)).size).toBe(3);
  });

  it('still turns a pointer taken twice into an ambiguous_ref skip', () => {
    const out = new Emitter('a.ts', 'zod', shared(CONTRACT_LIMITS));
    const f = {
      line: 1,
      pointer: '/s/a/type',
      owner: 's',
      field: 'a',
      rule: 'type' as const,
      value: 'string',
    };
    out.fact(f);
    out.fact(f);
    expect(out.facts).toHaveLength(1);
    expect(reasons(out.skipped)).toEqual(['ambiguous_ref']);
  });
});

describe('work is linear in the number of schemas and keys', () => {
  const timed = (files: Record<string, string>) => {
    const t = performance.now();
    const r = readFiles(files);
    return { ...r, ms: performance.now() - t };
  };

  it('reads a megabyte of one repeated schema quickly, with a typed skip at the cap', () => {
    const body = 'const x=z.object({});'.repeat(36_000);
    expect(body.length).toBeLessThan(MIB);
    const r = timed({ 'a.ts': body });
    expect(r.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(r.skipped)).toContain('too_many_schemas');
  });

  it('reads a long extend chain quickly, with a typed skip at the key cap', () => {
    const body = `const s=z.object({a:z.string()})${'.extend({a:z.string()})'.repeat(20_000)};`;
    const r = timed({ 'a.ts': body });
    expect(r.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(r.skipped)).toContain('too_many_keys');
  });

  it('counts a repeated variable name in constant time', () => {
    const body = 'const x=z.object({a:z.string().min(1)});'.repeat(4_000);
    const r = timed({ 'a.ts': body });
    expect(r.ms).toBeLessThan(LIMIT_MS);
    expect(pick(r.facts, 'a', 'minLength')).toHaveLength(4_000);
  });
});

describe('the pre-scan counts structure, not text', () => {
  it('does not refuse a file whose strings hold unbalanced brackets', () => {
    const props = Array.from(
      { length: 200 },
      (_, i) => `        p${i}: { type: string, pattern: '^[^[]+$' }`,
    ).join('\n');
    const prose = Array.from({ length: 200 }, (_, i) => `# note {${i}`).join(
      '\n',
    );
    const { facts, skipped } = readFiles({
      'a.yaml': `openapi: 3.1.0\n${prose}\ncomponents:\n  schemas:\n    A:\n      properties:\n${props}\n        q: { type: string, maxLength: 3, description: "a { b [ c" }\n`,
    });
    expect(reasons(skipped)).toEqual([]);
    expect(valueOf(facts, 'q', 'maxLength')).toBe('3');
    expect(pick(facts, 'p199', 'pattern')).toHaveLength(1);
  });

  it('still refuses real deep nesting', () => {
    const r = readFiles({
      'api.yaml': `openapi: 3.1.0\nx: ${'['.repeat(200)}`,
    });
    expect(reasons(r.skipped)).toEqual(['too_deep']);
  });
});

describe('names in skip reasons are escaped', () => {
  it('escapes an invisible character in a method or attribute name', () => {
    const r = readFiles({
      'a.ts': 'z.object({ a: z.string().a\u200db(1) });',
      'b.html': '<input name="n" \u001bX=1 \u001bX=2 required>',
    });
    for (const s of r.skipped) expect(s.reason).not.toMatch(/[\u200d\u001b]/u);
    expect(
      reasons(r.skipped).some((x) => x.startsWith('unsupported_method:')),
    ).toBe(true);
    expect(
      reasons(r.skipped).some((x) => x.startsWith('duplicate_attribute:')),
    ).toBe(true);
  });
});
