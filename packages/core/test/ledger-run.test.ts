import { describe, expect, it } from 'vitest';
import { RunLedger } from '../src/run/index.js';
import { idOf } from '../src/run/ledger/index.js';
import { type CreateConfirm, LedgerFile } from '../src/trust/index.js';
import { CREATE, STG, store } from './confirm-fixture.js';

/**
 * The run ledger without a browser (ADR 0024 section 5 and its amendment 2026-11-12, sections 1, 2 and 5): the id a
 * create answer names, the seen-set at mint, and the wait for response scans in flight.
 */
const ledger = (entries: CreateConfirm[] = [CREATE]): RunLedger =>
  new RunLedger({
    entries,
    file: LedgerFile.create(store().dir, 'r_unit01', null),
    uid: () => 'ab12cd34',
    refuse: () => undefined,
  });

const UUID = 'a1b2c3d4-0000-4000-8000-00000000abcd';
const LOCATION: CreateConfirm = { ...CREATE, idFrom: 'header:Location' };
const URL_ = `${STG}/api/items`;
const loc = (...values: string[]) =>
  values.map((value) => ({ name: 'Location', value }));
const why = (v: string | { why: string }): string =>
  typeof v === 'string' ? `id ${v}` : v.why;

describe('idOf', () => {
  it('reads a canonical int or uuid at a body pointer', () => {
    expect(why(idOf(CREATE, [], { id: 12 }, URL_))).toBe('id 12');
    expect(why(idOf(CREATE, [], { id: UUID.toUpperCase() }, URL_))).toBe(
      `id ${UUID}`,
    );
  });

  it('is ledger_mismatch for an array, an absent id or "0007" at idFrom', () => {
    expect(why(idOf(CREATE, [], { id: [12] }, URL_))).toContain(
      'no int or uuid',
    );
    expect(why(idOf(CREATE, [], {}, URL_))).toContain('no int or uuid');
    expect(why(idOf(CREATE, [], { id: '0007' }, URL_))).toContain(
      'no int or uuid',
    );
  });

  it('reads the one same-origin Location header whose path matches the cleanup template', () => {
    expect(why(idOf(LOCATION, loc('/api/items/12'), {}, URL_))).toBe('id 12');
  });

  it('is ledger_mismatch for two Location headers, a cross-origin one, or an id of the wrong type', () => {
    expect(
      why(idOf(LOCATION, loc('/api/items/12', '/api/items/13'), {}, URL_)),
    ).toContain('exactly one Location');
    expect(
      why(
        idOf(LOCATION, loc('https://evil.example.com/api/items/12'), {}, URL_),
      ),
    ).toContain('another origin');
    expect(why(idOf(LOCATION, loc(`/api/items/${UUID}`), {}, URL_))).toContain(
      'does not match the cleanup template',
    );
    expect(why(idOf(LOCATION, loc('/api/items/007'), {}, URL_))).toContain(
      'does not match the cleanup template',
    );
  });
});

describe('RunLedger', () => {
  it('puts a minted id into the seen-set, so a second 201 with it is ledger_replay', () => {
    const l = ledger([LOCATION]);
    l.mint(LOCATION, 1, '12');
    expect(l.seen?.has('12')).toBe(true);
  });

  it('waits for a response scan in flight before it says an id is new', async () => {
    const l = ledger();
    let release: (text: string) => void = () => undefined;
    void l.scanResponse(
      undefined,
      () =>
        new Promise<string>((resolve) => {
          release = resolve;
        }),
    );
    const seen = l.seenBefore('42');
    release('{"total":42}');
    expect(await seen).toBe(true);
    expect(await l.seenBefore('43')).toBe(false);
  });
});
