import { describe, expect, it } from 'vitest';
import {
  INVARIANT_IDS,
  expandInvariant,
  type InvariantId,
} from '../../src/derive/index.js';
import {
  APPROVE,
  EDIT_FIELD,
  NAME_FIELD,
  PAGE,
  PARAMS,
  cleanSteps,
  evidence,
} from './invariants-fixture.js';

const ref = (id: InvariantId) => ({ kind: 'invariant', ref: id });

const GOLDEN: Partial<Record<InvariantId, object>> = {
  'crud-create-appears': { text: 'QA-{{uid}}' },
  'crud-edit-shows': { text: 'QA-{{uid}}-e' },
  'reload-keeps-data': { text: 'QA-{{uid}}' },
  'no-console-error': { noConsoleErrors: true },
  'round-trip-equality': {
    value: { locator: NAME_FIELD, equals: 'QA-{{uid}}' },
  },
  'success-toast-implies-2xx': {
    network: { method: 'POST', url: '/api/items', status: 201 },
  },
};

const NOT_EXPANDABLE: InvariantId[] = [
  'crud-delete-absent',
  'no-5xx',
  'state-change-after-action',
  'client-blocks-what-server-rejects',
];

describe('expanding', () => {
  it('covers every invariant exactly once', () => {
    expect([...Object.keys(GOLDEN), ...NOT_EXPANDABLE].sort()).toEqual(
      [...INVARIANT_IDS].sort(),
    );
  });

  it.each(Object.entries(GOLDEN) as [InvariantId, object][])(
    '%s writes its fixed assertion with an invariant sourceRef only',
    (id, golden) => {
      expect(expandInvariant(id, evidence(), PARAMS[id])).toEqual({
        ok: true,
        assertion: { ...golden, sourceRef: ref(id) },
      });
    },
  );

  it.each(NOT_EXPANDABLE)(
    '%s is not expandable, and says it rather than writing a loose assertion',
    (id) => {
      expect(expandInvariant(id, evidence(), PARAMS[id])).toMatchObject({
        ok: false,
        reason: 'not_expandable',
      });
    },
  );

  it('copies the template text, never a value from the page', () => {
    const steps = cleanSteps().map((s) => ({ ...s, sent: 'QA-zzz' }));
    expect(
      expandInvariant(
        'crud-create-appears',
        evidence(steps),
        PARAMS['crud-create-appears'],
      ),
    ).toMatchObject({ assertion: { text: 'QA-{{uid}}' } });
  });

  it('holds the text within a region when the parameters name one', () => {
    const within = { role: 'list', name: 'Mục' } as const;
    const r = expandInvariant('crud-create-appears', evidence(), {
      ...PARAMS['crud-create-appears'],
      within,
    });
    expect(r).toMatchObject({ assertion: { text: 'QA-{{uid}}', within } });
  });

  it('refuses a request path a network assertion would read as a pattern', () => {
    const steps = cleanSteps().map((s) =>
      s.request === null
        ? s
        : { ...s, request: { ...s.request, path: '/api/*' } },
    );
    expect(
      expandInvariant(
        'success-toast-implies-2xx',
        evidence(steps),
        PARAMS['success-toast-implies-2xx'],
      ),
    ).toMatchObject({ ok: false, reason: 'not_expandable' });
  });

  it('refuses where binding refuses', () => {
    expect(
      expandInvariant('state-change-after-action', evidence([]), {
        page: PAGE,
        control: APPROVE,
      }),
    ).toMatchObject({ ok: false, reason: 'no_evidence' });
    expect(EDIT_FIELD.name).toBe('Tên mới');
  });
});
