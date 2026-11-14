import { describe, expect, it } from 'vitest';
import {
  checkConsistency,
  type ConsistencyCheck,
  readContracts,
} from '../../src/derive/index.js';
import { fixtureRoot, readFiles, reasons, rootOf } from './contract-fixture.js';

const KEYS = ['id', 'verdict', 'flow', 'step', 'assertion', 'sourceRef'];
const find = (
  checks: readonly ConsistencyCheck[],
  kind: string,
  field: string,
  rule: string,
): ConsistencyCheck[] =>
  checks.filter((c) => c.kind === kind && c.field === field && c.rule === rule);

const FORM =
  '<input name="reason" required maxlength="200" minlength="1">\n<input name="amount" min="0" max="1000000000">\n';
const ZOD = `export const s = z.object({
  reason: z.string().min(1, 'request.reason.required').max(200, 'request.reason.tooLong'),
  amount: z.number().min(0, 'request.amount.invalid').max(1e9),
});
`;

describe('the fixture app contracts', () => {
  const root = fixtureRoot();
  const { facts } = readContracts(root);
  const checks = checkConsistency({ facts });

  it('finds every message key of the OpenAPI document in vi.json', () => {
    const msgs = checks.filter((c) => c.kind === 'message_i18n');
    expect(msgs.length).toBe(4);
    expect(
      msgs.every(
        (c) =>
          c.outcome === 'equal' &&
          c.reason === 'key_found' &&
          c.locale === 'vi',
      ),
    ).toBe(true);
    expect(msgs[0]?.facts[1]?.value).toMatch(/\S/);
  });

  it('finds the fields of the error enum among the request properties', () => {
    const r = checks.filter((c) => c.kind === 'response_schema');
    expect(r.map((c) => [c.field, c.outcome]).sort()).toEqual([
      ['amount', 'equal'],
      ['reason', 'equal'],
    ]);
  });

  it('is partial on this app: no client source, so no client against server check', () => {
    expect(checks.some((c) => c.kind === 'client_server')).toBe(false);
  });
});

describe('client against server', () => {
  it('is equal when HTML, zod and OpenAPI say the same', () => {
    const files = { 'form.html': FORM, 'form.ts': ZOD, 'api.yaml': API };
    const { facts } = readContracts(rootOf(files));
    const checks = checkConsistency({ facts });
    expect(find(checks, 'client_server', 'reason', 'maxLength')).toMatchObject([
      { outcome: 'equal', reason: 'values_agree' },
    ]);
    expect(find(checks, 'client_server', 'amount', 'max')).toEqual([]);
  });

  it('reports a seeded maxlength mismatch as differs, with both facts', () => {
    const files = {
      'form.html': FORM.replace('maxlength="200"', 'maxlength="100"'),
    };
    const { facts } = readContracts(rootOf({ ...files, 'api.yaml': API }));
    const [c] = find(
      checkConsistency({ facts }),
      'client_server',
      'reason',
      'maxLength',
    );
    expect(c).toMatchObject({ outcome: 'differs', reason: 'values_differ' });
    expect(c?.facts.map((f) => [f.source, f.value]).sort()).toEqual([
      ['html', '100'],
      ['openapi', '200'],
    ]);
  });

  it('reports a rule one side lacks as missing, and a number that reads differently as a skip, not a fact', () => {
    const files = {
      'form.html': '<input name="reason" maxlength="0200" required>',
      'api.yaml': API,
    };
    const { facts, skipped } = readContracts(rootOf(files));
    expect(reasons(skipped)).toEqual(['ambiguous_number']);
    const checks = checkConsistency({ facts });
    expect(
      find(checks, 'client_server', 'reason', 'maxLength')[0],
    ).toMatchObject({ outcome: 'missing', reason: 'absent_on_client' });
    expect(
      find(checks, 'client_server', 'reason', 'minLength')[0],
    ).toMatchObject({ outcome: 'missing', reason: 'absent_on_client' });
  });

  it('compares a zod enum with an OpenAPI enum and reports drift', () => {
    const files = {
      'a.ts': "export const s = z.object({ type: z.enum(['LEAVE', 'SICK']) });",
      'api.yaml': API,
    };
    const [c] = find(
      checkConsistency(readContracts(rootOf(files))),
      'client_server',
      'type',
      'enum',
    );
    expect(c).toMatchObject({ outcome: 'differs' });
  });

  it('does not join a field that only one side names', () => {
    const { facts } = readContracts(
      rootOf({
        'form.html': '<input name="solo" maxlength="5">',
        'api.yaml': API,
      }),
    );
    expect(
      checkConsistency({ facts }).filter((c) => c.field === 'solo'),
    ).toEqual([]);
  });
});

describe('message against catalogue', () => {
  it('reports a missing key per locale with the message fact, and a key that exists as equal', () => {
    const files = {
      'a.ts': ZOD.replace("'request.reason.tooLong'", "'request.reason.gone'"),
      'i18n/vi.json': JSON.stringify({
        request: {
          reason: { required: 'Bắt buộc' },
          amount: { invalid: 'Sai' },
        },
      }),
      'i18n/en.json': JSON.stringify({
        request: { reason: { required: 'Required' } },
      }),
    };
    const checks = checkConsistency(readContracts(rootOf(files))).filter(
      (c) => c.kind === 'message_i18n',
    );
    const gone = checks.filter(
      (c) => c.facts[0]?.messageKey === 'request.reason.gone',
    );
    expect(gone.map((c) => [c.locale, c.outcome, c.reason])).toEqual([
      ['en', 'missing', 'key_missing'],
      ['vi', 'missing', 'key_missing'],
    ]);
    expect(gone[0]?.facts).toHaveLength(1);
    const amount = checks.filter(
      (c) => c.facts[0]?.messageKey === 'request.amount.invalid',
    );
    expect(amount.map((c) => [c.locale, c.outcome])).toEqual([
      ['en', 'missing'],
      ['vi', 'equal'],
    ]);
  });

  it('is unknown, never equal, for literal text and when no catalogue was read', () => {
    const a = checkConsistency(
      readContracts(
        rootOf({
          'a.ts':
            "export const s = z.object({ a: z.string().min(1, 'Please fill this in') });",
        }),
      ),
    );
    expect(a.map((c) => [c.outcome, c.reason])).toEqual([
      ['unknown', 'not_a_key'],
    ]);
    const b = checkConsistency(
      readContracts(
        rootOf({
          'a.ts':
            "export const s = z.object({ a: z.string().min(1, 'form.a.required') });",
        }),
      ),
    );
    expect(b.map((c) => [c.outcome, c.reason])).toEqual([
      ['unknown', 'no_catalogue'],
    ]);
  });
});

describe('response against schema', () => {
  const api = (enumList: string): string => `openapi: 3.1.0
paths:
  /x:
    post:
      requestBody: { content: { application/json: { schema: { $ref: '#/components/schemas/In' } } } }
      responses:
        '400': { content: { application/json: { schema: { $ref: '#/components/schemas/Err' } } } }
components:
  schemas:
    Base: { type: object, properties: { id: { type: string } } }
    In: { allOf: [ { $ref: '#/components/schemas/Base' }, { type: object, properties: { name: { type: string } } } ] }
    Err: { type: object, properties: { field: { type: string, enum: ${enumList} } } }
`;

  it('finds fields through allOf and reports one that no request property has as missing', () => {
    const checks = checkConsistency(
      readContracts(rootOf({ 'a.yaml': api('[id, name, ghost]') })),
    );
    expect(checks.map((c) => [c.field, c.outcome, c.reason]).sort()).toEqual([
      ['ghost', 'missing', 'field_missing'],
      ['id', 'equal', 'field_found'],
      ['name', 'equal', 'field_found'],
    ]);
  });

  it('is unknown when the operation has no request schema', () => {
    const doc = api('[a]').replace(/      requestBody:.*\n/, '');
    const checks = checkConsistency(readContracts(rootOf({ 'a.yaml': doc })));
    expect(checks).toMatchObject([
      { field: 'a', outcome: 'unknown', reason: 'no_request_schema' },
    ]);
  });
});

describe('what a check is', () => {
  it('carries facts and a fixed reason, and no verdict, flow, step or assertion', () => {
    const { facts } = readContracts(
      rootOf({ 'form.html': FORM, 'form.ts': ZOD, 'api.yaml': API }),
    );
    const checks = checkConsistency({ facts });
    expect(checks.length).toBeGreaterThan(0);
    for (const c of checks) {
      expect(Object.keys(c).filter((k) => KEYS.includes(k))).toEqual([]);
      expect(c.reason).toMatch(/^[a-z_]+$/);
      expect(['equal', 'differs', 'missing', 'unknown']).toContain(c.outcome);
    }
  });

  it('never reports equal for a side it could not read', () => {
    const { facts } = readFiles({
      'form.html': FORM,
      'a.ts':
        'export const s = z.object({ reason: z.string().max(importedLimit) });',
    });
    const checks = checkConsistency({ facts });
    expect(checks.filter((c) => c.outcome === 'equal')).toEqual([]);
  });
});

const API = `openapi: 3.1.0
components:
  schemas:
    In:
      type: object
      required: [reason]
      properties:
        reason: { type: string, minLength: 1, maxLength: 200 }
        type: { type: string, enum: [LEAVE] }
`;
