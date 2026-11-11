import { describe, expect, it } from 'vitest';
import { cleanIds, idTokens, SeenSet } from '../src/run/index.js';
import type { CleanupTiming } from '../src/run/ledger/index.js';
import { CREATE, refusal } from './confirm-fixture.js';

/**
 * The seen-set of id-shaped tokens and the cleanup procedure (ADR 0024 amendment 2026-11-12 "destructive ledger
 * details", sections 1 and 7), without a browser: a fake clock and a scripted server.
 */
describe('idTokens and SeenSet', () => {
  it('takes every digit run of 1 to 18 digits without leading zeros, and uuids lower-cased', () => {
    expect(idTokens('Total 7')).toEqual(['7']);
    expect(idTokens('a007b000')).toEqual(['7', '0']);
    expect(idTokens('1234567890123456789')).toEqual([]);
    expect(idTokens('ABCDEF01-2345-6789-ABCD-EF0123456789')).toContain(
      'abcdef01-2345-6789-abcd-ef0123456789',
    );
  });

  it('ends the run ledger_overflow past 100 000 tokens (seen) or for a body over 8 MiB (body)', () => {
    const s = new SeenSet();
    const many = Array.from({ length: 100_001 }, (_, i) => String(i)).join(' ');
    expect(refusal(() => s.add(many, 'a response body'))).toMatch(
      /^ledger_overflow: ledger_overflow \(seen\)/,
    );
    expect(
      refusal(() =>
        new SeenSet().add('x'.repeat(9 * 1024 * 1024), 'a response body'),
      ),
    ).toContain('(body)');
  });
});

/** A fake clock: `sleep` moves it, every request costs `cost` ms. */
function clock(cost = 0): CleanupTiming & { slept: number[] } {
  let t = 0;
  const slept: number[] = [];
  return {
    slept,
    budgetMs: 120_000,
    now: () => t,
    sleep: (ms) => {
      slept.push(ms);
      t += ms;
      return Promise.resolve();
    },
    ...(cost > 0 ? { now: () => (t += cost) } : {}),
  };
}

const target = (id: string, seq: number) => ({ entry: CREATE, id, seq });

describe('cleanIds', () => {
  it('deletes the last created first, retries a 500 once after 1 s, and confirms on a verify 404 after 200, 200', async () => {
    const sent: string[] = [];
    const answers = new Map<string, (number | 'error')[]>([
      ['DELETE /api/items/2', [204]],
      ['DELETE /api/items/1', [500, 204]],
      ['GET /api/items/2', [404]],
      ['GET /api/items/1', [200, 200, 404]],
    ]);
    const t = clock();
    const lines: string[] = [];
    const r = await cleanIds(
      [target('1', 1), target('2', 2)],
      (method, url) => {
        const key = `${method} ${new URL(url).pathname}`;
        sent.push(key);
        return Promise.resolve(answers.get(key)?.shift() ?? 'error');
      },
      (x, result) => lines.push(`${x.id} ${result}`),
      t,
    );
    expect(sent).toEqual([
      'DELETE /api/items/2',
      'GET /api/items/2',
      'DELETE /api/items/1',
      'DELETE /api/items/1',
      'GET /api/items/1',
      'GET /api/items/1',
      'GET /api/items/1',
    ]);
    expect(t.slept).toEqual([1000, 1000, 2000]);
    expect(r).toEqual({ confirmed: 2, leftover: [] });
    expect(lines).toEqual(['2 confirmed', '1 confirmed']);
  });

  it('leaves an id whose verify answers 200 three times, and one whose cleanup answers 403, without stopping', async () => {
    const r = await cleanIds(
      [target('1', 1), target('2', 2)],
      (method, url) =>
        Promise.resolve(
          url.endsWith('/2') ? (method === 'DELETE' ? 403 : 200) : 200,
        ),
      () => undefined,
      clock(),
    );
    expect(r.leftover.map((l) => `${l.id} ${l.detail}`)).toEqual([
      '2 cleanup_failed',
      '1 verify_failed',
    ]);
  });

  it('leaves the ids it does not reach within 120 s', async () => {
    const r = await cleanIds(
      [target('1', 1), target('2', 2), target('3', 3)],
      () => Promise.resolve(404),
      () => undefined,
      clock(50_000),
    );
    expect(r.leftover.map((l) => `${l.id} ${l.detail}`)).toContain('1 timeout');
  });
});
