import { describe, expect, it } from 'vitest';
import {
  INVARIANT_IDS,
  expandInvariant,
  type InvariantId,
} from '../../src/derive/index.js';
import {
  APPROVE,
  CREATE,
  LIST,
  PAGE,
  PARAMS,
  cleanSteps,
  evidence,
} from './invariants-fixture.js';

const ref = (id: InvariantId) => ({ kind: 'invariant', ref: id });

const GOLDEN: Partial<Record<InvariantId, object>> = {
  'crud-create-appears': { text: 'QA-{{uid}}', within: LIST },
  'crud-edit-shows': { text: 'QA-{{uid}}-e', within: LIST },
  'no-console-error': { noConsoleErrors: true },
};

/**
 * The templates whose assertion cannot catch their own seeded bug (ADR 0041 section 5): no status class, no text
 * absence, no comparison of two observations, no forced reload, no read-back from a fresh load, no toast tied to a
 * status.
 */
const NOT_EXPANDABLE: InvariantId[] = [
  'crud-delete-absent',
  'reload-keeps-data',
  'no-5xx',
  'round-trip-equality',
  'state-change-after-action',
  'success-toast-implies-2xx',
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
    const steps = cleanSteps().map((s) =>
      s.action === 'create' ? { ...s, sent: 'QA-abc' } : s,
    );
    expect(
      expandInvariant(
        'crud-create-appears',
        evidence(steps),
        PARAMS['crud-create-appears'],
      ),
    ).toMatchObject({ assertion: { text: 'QA-{{uid}}' } });
  });

  it.each(['crud-create-appears', 'crud-edit-shows'] as const)(
    '%s refuses to expand without a list region to hold the text to',
    (id) => {
      const { within: _w, ...bare } = PARAMS[id];
      expect(expandInvariant(id, evidence(), bare)).toMatchObject({
        ok: false,
        reason: 'no_evidence',
      });
    },
  );

  it('refuses to hold the text to a control: only a region of the map holds a list', () => {
    expect(
      expandInvariant('crud-create-appears', evidence(), {
        ...PARAMS['crud-create-appears'],
        within: CREATE,
      }),
    ).toMatchObject({ ok: false, reason: 'no_evidence' });
  });

  it('refuses where binding refuses', () => {
    expect(
      expandInvariant('state-change-after-action', evidence([]), {
        page: PAGE,
        control: APPROVE,
      }),
    ).toMatchObject({ ok: false, reason: 'no_evidence' });
  });
});
