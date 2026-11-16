import { describe, expect, it } from 'vitest';
import { readContracts } from '../../src/derive/index.js';
import { fixtureRoot, pick, valueOf } from './contract-fixture.js';

describe('OpenAPI facts of the fixture app contract', () => {
  const { facts, skipped } = readContracts(fixtureRoot(), { rootName: 'api' });
  const openapi = facts.filter((f) => f.source === 'openapi');

  it('reads the numbers and message keys of NewLeaveRequest', () => {
    expect(valueOf(openapi, 'reason', 'minLength')).toBe('1');
    expect(valueOf(openapi, 'reason', 'maxLength')).toBe('200');
    expect(pick(openapi, 'reason', 'maxLength')[0]?.messageKey).toBe(
      'request.reason.tooLong',
    );
    expect(pick(openapi, 'reason', 'minLength')[0]?.messageKey).toBe(
      'request.reason.required',
    );
    expect(valueOf(openapi, 'amount', 'min')).toBe('0');
    expect(valueOf(openapi, 'amount', 'max')).toBe('1000000000');
    expect(pick(openapi, 'amount', 'max')[0]?.messageKey).toBe(
      'request.amount.invalid',
    );
    expect(pick(openapi, 'type', 'enum').map((f) => f.value)).toEqual([
      '["LEAVE"]',
    ]);
  });

  it('reads the required fields, the status codes and the error field enum', () => {
    expect(pick(openapi, 'reason', 'required')).toHaveLength(1);
    expect(pick(openapi, '400', 'status')[0]?.owner).toBe('POST /api/requests');
    expect(pick(openapi, 'field', 'enum')[0]?.value).toBe(
      '["amount","reason"]',
    );
    expect(pick(openapi, '400', 'schema')[0]?.value).toBe('RuleError');
  });

  it('records allOf and the operation links as schema facts, with pointers into the document', () => {
    expect(pick(openapi, 'allOf', 'schema')[0]?.value).toBe('NewLeaveRequest');
    expect(pick(openapi, 'request', 'schema')[0]?.value).toBe(
      'NewLeaveRequest',
    );
    expect(pick(openapi, 'reason', 'maxLength')[0]?.pointer).toBe(
      '/components/schemas/NewLeaveRequest/properties/reason/maxLength',
    );
    expect(pick(openapi, 'id', 'min').map((f) => f.owner)).toEqual([
      'LeaveRequest',
      'PATCH /api/requests/{id}/approve',
    ]);
  });

  it('reads a response that is a reference to components/responses', () => {
    expect(pick(openapi, '401', 'status').length).toBeGreaterThan(0);
    expect(skipped.filter((s) => s.file === 'openapi.yaml')).toEqual([]);
  });

  it('gives the same facts twice', () => {
    expect(readContracts(fixtureRoot(), { rootName: 'api' })).toEqual({
      facts,
      skipped,
      files: 2,
      bytes: expect.any(Number),
    });
  });
});
