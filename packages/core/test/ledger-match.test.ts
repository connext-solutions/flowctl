import { describe, expect, it } from 'vitest';
import {
  canonicalId,
  type ConfirmEntry,
  idValues,
  matchEntry,
  readBody,
  type WireRequest,
} from '../src/trust/index.js';
import { CREATE, MUTATE, STG } from './confirm-fixture.js';

/**
 * Matching a request against stored `destructiveConfirm` entries (ADR 0024 section 5, ledger rules 4, 6 and 7, and
 * the amendment 2026-11-12 "destructive ledger details", section 2): strict bodies, exact templates, closed query
 * and header lists, id positions.
 */
const json = (v: unknown): Buffer => Buffer.from(JSON.stringify(v));

const req = (over: Partial<WireRequest> = {}): WireRequest => ({
  method: 'POST',
  url: `${STG}/api/items`,
  headers: {
    'content-type': 'application/json',
    origin: STG,
    accept: '*/*',
    'sec-fetch-mode': 'cors',
  },
  body: json({ name: 'QA-ab12cd34', code: 'QA-1' }),
  ...over,
});

const entries: ConfirmEntry[] = [CREATE, MUTATE];

describe('readBody', () => {
  it('refuses duplicate keys at any depth, a BOM, bytes that are not UTF-8 and a member named *', () => {
    const t = 'application/json';
    expect(readBody(Buffer.from('{"a":{"b":1,"b":2}}'), t, 'json')).toContain(
      'appears twice',
    );
    expect(readBody(Buffer.from('\uFEFF{"a":1}'), t, 'json')).toContain('BOM');
    expect(readBody(Buffer.from([0x7b, 0xff, 0x7d]), t, 'json')).toContain(
      'not UTF-8',
    );
    expect(readBody(json({ '*': 1 }), t, 'json')).toContain('"*"');
    expect(readBody(json({ a: 1 }), 'text/plain', 'json')).toContain(
      'Content-Type',
    );
    expect(readBody(json({ a: 1 }), undefined, 'json')).toContain(
      'without a Content-Type',
    );
    expect(
      readBody(
        Buffer.from('a=1&a=2'),
        'application/x-www-form-urlencoded',
        'urlencoded',
      ),
    ).toContain('twice');
  });

  it('gives every leaf with its general pointer, arrays as *', () => {
    const leaves = readBody(
      json({ lines: [{ qty: 1 }, { qty: 2 }], 'a/b': true }),
      'application/json',
      'json',
    );
    expect(leaves).toEqual([
      { pointer: '/lines/0/qty', general: '/lines/*/qty', value: 1 },
      { pointer: '/lines/1/qty', general: '/lines/*/qty', value: 2 },
      { pointer: '/a~1b', general: '/a~1b', value: true },
    ]);
  });
});

describe('matchEntry', () => {
  it('matches a create whose body holds only listed keys', () => {
    const m = matchEntry(req(), entries);
    expect(typeof m === 'string' ? m : m.entry.id).toBe('items-create');
  });

  it('admits bodyKeys /lines/*/qty and blocks an unlisted field inside the array', () => {
    const ok = matchEntry(
      req({
        body: json({
          name: 'QA-x',
          code: 'QA-1',
          lines: [{ qty: 1 }, { qty: 2 }],
        }),
      }),
      entries,
    );
    expect(typeof ok).not.toBe('string');
    const bad = matchEntry(
      req({
        body: json({ name: 'QA-x', code: 'QA-1', lines: [{ qty: 1, x: 0 }] }),
      }),
      entries,
    );
    expect(bad).toContain('/lines/*/x');
  });

  it('blocks a filter key, an unlisted query name, an unlisted header and a method override header', () => {
    expect(
      matchEntry(req({ body: json({ name: 'QA-x', all: true }) }), entries),
    ).toContain('/all');
    expect(
      matchEntry(req({ url: `${STG}/api/items?force=1` }), entries),
    ).toContain('force');
    expect(matchEntry(req({ url: `${STG}/api/items?` }), entries)).toContain(
      'empty query',
    );
    expect(
      matchEntry(
        req({
          headers: { ...req().headers, 'x-http-method-override': 'DELETE' },
        }),
        entries,
      ),
    ).toContain('x-http-method-override');
    expect(
      matchEntry(
        req({ headers: { ...req().headers, origin: 'https://evil.example' } }),
        entries,
      ),
    ).toContain('Origin');
  });

  it('matches a path exactly as sent: leading zeros, upper-case uuid and escapes do not match', () => {
    const del = (path: string): WireRequest =>
      req({
        method: 'PATCH',
        url: `${STG}${path}`,
        body: json({ name: 'QA-y' }),
      });
    const m = matchEntry(del('/api/items/12'), entries);
    expect(typeof m === 'string' ? m : m.pathIds).toEqual(['12']);
    expect(matchEntry(del('/api/items/012'), entries)).toContain(
      'no destructiveConfirm entry',
    );
    expect(matchEntry(del('/api/%69tems/12'), entries)).toContain(
      'no destructiveConfirm entry',
    );
    expect(matchEntry(del('/api/items/12/'), entries)).toContain(
      'no destructiveConfirm entry',
    );
    expect(
      matchEntry(
        { ...del('/api/items/12'), url: `https://other.example/api/items/12` },
        entries,
      ),
    ).toContain('no destructiveConfirm entry');
  });
});

describe('idValues', () => {
  const bulk: ConfirmEntry = {
    ...MUTATE,
    id: 'items-bulk',
    method: 'DELETE',
    template: '/api/items',
    bodyKeys: ['/ids/*'],
    idPositions: ['body:/ids/*'],
  };
  const send = (ids: unknown[]): WireRequest =>
    req({ method: 'DELETE', url: `${STG}/api/items`, body: json({ ids }) });

  it('reads every element of an explicit id array, at most 20', () => {
    const m = matchEntry(send([3, '4']), [bulk]);
    expect(typeof m === 'string' ? m : idValues(m)).toEqual(['3', '4']);
    const many = matchEntry(send(Array.from({ length: 21 }, (_, i) => i + 1)), [
      bulk,
    ]);
    expect(typeof many === 'string' ? many : idValues(many)).toContain(
      'more than 20',
    );
    const shaped = matchEntry(send([{ id: 1 }]), [bulk]);
    expect(typeof shaped).toBe('string');
  });

  it('canonicalises ids: a JSON string with leading zeros is not an id, an upper-case uuid is lowered', () => {
    expect(canonicalId(12)).toBe('12');
    expect(canonicalId('0007')).toBeUndefined();
    expect(canonicalId(1.5)).toBeUndefined();
    expect(canonicalId('ABCDEF01-2345-6789-ABCD-EF0123456789')).toBe(
      'abcdef01-2345-6789-abcd-ef0123456789',
    );
  });
});
