import { describe, expect, it } from 'vitest';
import {
  DRIVE_POINTER,
  INVARIANT_IDS,
  INVARIANTS,
  evaluateInvariant,
  type DriveStep,
  type InvariantId,
} from '../../src/derive/index.js';
import { freeChecks, AppMapSchema } from '../../src/observe/index.js';
import {
  APPROVE,
  PARAMS,
  cleanSteps,
  evidence,
  itemsMap,
} from './invariants-fixture.js';

const OK = { listed: true, state: null };
const NO = { listed: false, state: null };

/** The clean drive with step `i` changed: the defect of one seeded bug, written from what it breaks. */
const broken = (i: number, over: Partial<DriveStep>) =>
  evidence(cleanSteps().map((s, j) => (j === i ? { ...s, ...over } : s)));

const DEFECTS: [InvariantId, ReturnType<typeof evidence>, string][] = [
  ['crud-create-appears', broken(0, { after: NO }), '/steps/0/after'],
  ['crud-edit-shows', broken(2, { after: NO }), '/steps/2/after'],
  ['crud-delete-absent', broken(4, { after: OK }), '/steps/4/after'],
  ['reload-keeps-data', broken(0, { reloaded: NO }), '/steps/0/reloaded'],
  [
    'round-trip-equality',
    broken(0, { readBack: 'QA-1.' }),
    '/steps/0/readBack',
  ],
  [
    'state-change-after-action',
    broken(3, { after: { listed: true, state: 'Chờ duyệt' } }),
    '/steps/3/after',
  ],
  [
    'success-toast-implies-2xx',
    broken(1, { toast: 'Đã tạo QA-1' }),
    '/steps/1/toast',
  ],
  [
    'client-blocks-what-server-rejects',
    broken(5, {
      clientBlocked: false,
      request: { method: 'POST', path: '/api/items', status: 400 },
    }),
    '/steps/5/request/status',
  ],
];

describe('evaluating', () => {
  it.each([...INVARIANT_IDS])('%s finds nothing on the clean drive', (id) => {
    expect(evaluateInvariant(id, evidence(), PARAMS[id])).toEqual({
      ok: true,
      findings: [],
    });
  });

  it.each(DEFECTS)('%s reports its own defect once', (id, e, pointer) => {
    const r = evaluateInvariant(id, e, PARAMS[id]);
    expect(r).toMatchObject({ ok: true });
    const findings = r.ok ? r.findings : [];
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      invariant: id,
      page: '/items',
      sourceRef: { kind: 'invariant', ref: id },
      observation: { kind: 'observation', file: 'drive.json', pointer },
    });
    expect(DRIVE_POINTER.test(findings[0]?.observation.pointer ?? '')).toBe(
      true,
    );
  });

  it('judges only a successful request for the CRUD invariants', () => {
    const e = broken(0, {
      after: NO,
      request: { method: 'POST', path: '/api/items', status: 500 },
    });
    expect(
      evaluateInvariant(
        'crud-create-appears',
        e,
        PARAMS['crud-create-appears'],
      ),
    ).toEqual({ ok: true, findings: [] });
  });

  it('reports a transition that answered 2xx and did not change the state', () => {
    const r = evaluateInvariant('state-change-after-action', DEFECTS[5]?.[1], {
      page: '/items',
      control: APPROVE,
    });
    expect(r).toMatchObject({ ok: true, findings: [{ status: 200 }] });
  });
});

describe('the free invariants', () => {
  const crashed = AppMapSchema.parse(
    itemsMap({
      status: 500,
      consoleErrors: ['TypeError: x'],
      calls: [{ method: 'GET', path: '/api/items', status: 503 }],
    }),
  );

  it.each(['no-5xx', 'no-console-error'] as const)(
    '%s gives the verdict of the free check of the same id',
    (id) => {
      const free = freeChecks(crashed).checks.find((c) => c.id === id);
      const r = evaluateInvariant(id, evidence([], crashed), {});
      expect(free?.findings.length).toBeGreaterThan(0);
      expect(r.ok && r.findings.map((f) => f.observation.pointer)).toEqual(
        free?.findings.map((f) => f.observation.pointer),
      );
      expect(r.ok && r.findings.map((f) => f.status)).toEqual(
        free?.findings.map((f) => f.status),
      );
    },
  );

  it('points into appmap.json with the pattern of the free checks', () => {
    const r = evaluateInvariant('no-5xx', evidence([], crashed), {});
    for (const f of r.ok ? r.findings : [])
      expect(f.observation).toMatchObject({ file: 'appmap.json' });
    expect((r.ok ? r.findings : []).map((f) => f.observation.pointer)).toEqual([
      '/pages/0/status',
      '/pages/0/calls/0/status',
    ]);
  });

  it('needs no drive', () => {
    expect(INVARIANTS['no-console-error'].bind(evidence([]), {})).toMatchObject(
      { ok: true },
    );
  });
});
