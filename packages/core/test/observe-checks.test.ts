import { describe, expect, it } from 'vitest';
import {
  CHECK_IDS,
  FreeChecksSchema,
  freeChecks,
} from '../src/observe/index.js';
import { at, check, mapOf, pageAt, ref } from './free-checks-maps.js';

/** Free checks (T2.4): verdicts from an `AppMap` alone, each finding pointing at the map entry it stands on. */
describe('freeChecks', () => {
  it('passes every check on a clean map, in the fixed order', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/', {
          links: ['/a'],
          calls: [{ method: 'GET', path: '/api', status: 200 }],
        }),
        pageAt('/a', { links: ['/'] }),
      ]),
    );
    expect(r.status).toBe('passed');
    expect(r.checks.map((c) => c.id)).toEqual([...CHECK_IDS]);
    for (const c of r.checks)
      expect(c).toMatchObject({ status: 'passed', findings: [], omitted: 0 });
    expect(FreeChecksSchema.parse(r)).toEqual(r);
  });

  it('reports each console error of each page with its message', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/'),
        pageAt('/r', { consoleErrors: ['a failed', 'b failed'] }),
      ]),
    );
    expect(r.status).toBe('failed');
    expect(check(r, 'no-console-error')).toEqual({
      id: 'no-console-error',
      status: 'failed',
      omitted: 0,
      findings: [
        {
          check: 'no-console-error',
          page: '/r',
          message: 'a failed',
          sourceRef: ref('no-console-error'),
          observation: at('/pages/1/consoleErrors/0'),
        },
        {
          check: 'no-console-error',
          page: '/r',
          message: 'b failed',
          sourceRef: ref('no-console-error'),
          observation: at('/pages/1/consoleErrors/1'),
        },
      ],
    });
  });

  it('reports 4xx document statuses, and 5xx document and call statuses, under their own check', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/gone', { status: 404 }),
        pageAt('/down', { status: 503 }),
        pageAt('/ok', {
          calls: [
            { method: 'GET', path: '/api/a', status: 200 },
            { method: 'GET', path: '/api/me', status: 401 },
            {
              method: 'GET',
              path: '/api/b',
              status: 500,
              origin: 'https://api.example',
            },
            { method: 'GET', path: '/api/c', status: 0 },
          ],
        }),
      ]),
    );
    expect(check(r, 'no-4xx').findings).toEqual([
      {
        check: 'no-4xx',
        page: '/gone',
        status: 404,
        sourceRef: ref('no-4xx'),
        observation: at('/pages/0/status'),
      },
    ]);
    expect(check(r, 'no-5xx').findings).toEqual([
      {
        check: 'no-5xx',
        page: '/down',
        status: 503,
        sourceRef: ref('no-5xx'),
        observation: at('/pages/1/status'),
      },
      {
        check: 'no-5xx',
        page: '/ok',
        status: 500,
        call: { method: 'GET', path: '/api/b', origin: 'https://api.example' },
        sourceRef: ref('no-5xx'),
        observation: at('/pages/2/calls/2/status'),
      },
    ]);
  });

  it('does not judge a 4xx fetch/xhr call: an app may probe with an expected 401, 404 or 422', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/', {
          calls: [
            { method: 'GET', path: '/api/me', status: 401 },
            { method: 'GET', path: '/api/draft', status: 404 },
            { method: 'POST', path: '/api/check', status: 422 },
          ],
        }),
      ]),
    );
    expect(r.status).toBe('passed');
    expect(check(r, 'no-4xx').findings).toEqual([]);
  });

  it('carries the map origin and truncated flag, so a pass on a cut map reads as partial', () => {
    const r = freeChecks(mapOf([pageAt('/')], true));
    expect(r).toMatchObject({
      v: 1,
      origin: 'http://127.0.0.1:5173',
      truncated: true,
      status: 'passed',
    });
  });

  it('keeps at most 200 findings per check and counts the rest', () => {
    const r = freeChecks(
      mapOf([
        pageAt('/', {
          consoleErrors: Array.from(
            { length: 100 },
            (_, i) => `e${String(i).padStart(3, '0')}`,
          ),
        }),
        pageAt('/b', {
          consoleErrors: Array.from({ length: 100 }, (_, i) => `e${i}`),
        }),
        pageAt('/c', {
          consoleErrors: Array.from({ length: 5 }, (_, i) => `e${i}`),
        }),
      ]),
    );
    const c = check(r, 'no-console-error');
    expect(c.findings).toHaveLength(200);
    expect(c.omitted).toBe(5);
    expect(c.findings.at(-1)?.page).toBe('/b');
    expect(FreeChecksSchema.parse(r)).toEqual(r);
  });

  it('gives the same result for the same map, and never invents a value the map does not hold', () => {
    const m = mapOf([
      pageAt('/', { links: ['/x'], consoleErrors: ['boom'] }),
      pageAt('/x', {
        status: 500,
        calls: [{ method: 'POST', path: '/api', status: 422 }],
      }),
    ]);
    const a = freeChecks(m);
    expect(freeChecks(m)).toEqual(a);
    const text = JSON.stringify(a);
    for (const f of a.checks.flatMap((c) => c.findings)) {
      expect(m.pages.some((p) => p.path === f.page)).toBe(true);
      expect(f.sourceRef.ref).toBe(f.check);
    }
    expect(text).not.toMatch(/expected|should/i);
  });

  it('rejects a finding whose sourceRef names another check, or a pointer that is not into the map', () => {
    const r = freeChecks(mapOf([pageAt('/', { status: 500 })]));
    const bad = structuredClone(r);
    const f = bad.checks.find((c) => c.id === 'no-5xx')?.findings[0];
    if (f === undefined) throw new Error('no finding');
    expect(FreeChecksSchema.safeParse(bad).success).toBe(true);
    f.sourceRef = { kind: 'invariant', ref: 'no-4xx' };
    expect(FreeChecksSchema.safeParse(bad).success).toBe(false);
    f.sourceRef = { kind: 'invariant', ref: 'no-5xx' };
    f.observation.pointer = '../run.json';
    expect(FreeChecksSchema.safeParse(bad).success).toBe(false);
  });
});
