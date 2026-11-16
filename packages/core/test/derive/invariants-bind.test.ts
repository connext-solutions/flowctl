import { describe, expect, it } from 'vitest';
import {
  INVARIANT_IDS,
  INVARIANTS,
  type InvariantEvidence,
} from '../../src/derive/index.js';
import {
  PAGE,
  PARAMS,
  cleanSteps,
  evidence,
  itemsMap,
  step,
} from './invariants-fixture.js';

const DRIVE_IDS = INVARIANT_IDS.filter(
  (id) => id !== 'no-5xx' && id !== 'no-console-error',
);

describe('binding', () => {
  it.each([...INVARIANT_IDS])('%s binds with matching evidence', (id) => {
    expect(INVARIANTS[id].bind(evidence(), PARAMS[id])).toMatchObject({
      ok: true,
    });
  });

  it.each([...DRIVE_IDS])('%s is refused without a drive', (id) => {
    const e: InvariantEvidence = { map: itemsMap(), inputs: {} } as never;
    expect(INVARIANTS[id].bind(e, PARAMS[id])).toMatchObject({ ok: false });
  });

  it.each([...DRIVE_IDS])('%s is refused for a page not in the map', (id) => {
    const params = { ...PARAMS[id], page: '/missing' };
    expect(INVARIANTS[id].bind(evidence(), params)).toMatchObject({
      ok: false,
      reason: 'no_evidence',
    });
  });

  it.each([
    ['crud-create-appears', 'create'],
    ['crud-edit-shows', 'edit'],
    ['crud-delete-absent', 'delete'],
    ['state-change-after-action', 'transition'],
    ['client-blocks-what-server-rejects', 'probe'],
  ] as const)('%s is refused when the drive has no %s step', (id, action) => {
    const steps = cleanSteps().filter((s) => s.action !== action);
    expect(INVARIANTS[id].bind(evidence(steps), PARAMS[id])).toMatchObject({
      ok: false,
      reason: 'no_evidence',
    });
  });

  it('refuses reload-keeps-data when no step reloaded the page', () => {
    const steps = cleanSteps().map((s) => ({ ...s, reloaded: null }));
    expect(
      INVARIANTS['reload-keeps-data'].bind(
        evidence(steps),
        PARAMS['reload-keeps-data'],
      ),
    ).toMatchObject({ reason: 'no_evidence' });
  });

  it('refuses round-trip-equality when nothing was read back', () => {
    const steps = cleanSteps().map((s) => ({ ...s, readBack: null }));
    expect(
      INVARIANTS['round-trip-equality'].bind(
        evidence(steps),
        PARAMS['round-trip-equality'],
      ),
    ).toMatchObject({ reason: 'no_evidence' });
  });

  it('refuses the toast invariant when no accepted request showed a toast', () => {
    const steps = [
      step({ request: { method: 'POST', path: '/api/items', status: 409 } }),
    ];
    expect(
      INVARIANTS['success-toast-implies-2xx'].bind(
        evidence(steps),
        PARAMS['success-toast-implies-2xx'],
      ),
    ).toMatchObject({ reason: 'no_evidence' });
  });

  it.each([
    ['is missing', undefined],
    ['has no QA- prefix', 'name-{{uid}}'],
    ['has no {{uid}}', 'QA-fixed'],
  ])('refuses a value input that %s', (_name, template) => {
    const e = {
      ...evidence(),
      inputs: template === undefined ? {} : { name: template },
    };
    expect(
      INVARIANTS['crud-create-appears'].bind(e, PARAMS['crud-create-appears']),
    ).toMatchObject({ ok: false, reason: 'bad_input' });
  });

  it('refuses a drive step that writes a value without the QA- prefix', () => {
    const e = evidence([step({ sent: 'Nguyễn' })]);
    expect(
      INVARIANTS['crud-create-appears'].bind(e, PARAMS['crud-create-appears']),
    ).toMatchObject({ reason: 'bad_input' });
  });

  it.each([
    ['a control character in a toast', { toast: 'Đã\u0007tạo' }],
    ['a right-to-left mark in a read-back', { readBack: 'QA‮1' }],
    ['a zero-width space in a value', { sent: 'QA-​1' }],
  ])('refuses hostile evidence: %s', (_name, over) => {
    const e = evidence([step(over)]);
    expect(
      INVARIANTS['crud-create-appears'].bind(e, PARAMS['crud-create-appears']),
    ).toMatchObject({ reason: 'bad_input' });
  });

  it('never echoes page text in a refusal', () => {
    const e = evidence([step({ toast: 'x\u0007'.repeat(3) })]);
    const r = INVARIANTS['crud-create-appears'].bind(
      e,
      PARAMS['crud-create-appears'],
    );
    expect(JSON.stringify(r)).not.toContain(PAGE + 'x');
    expect(r).toMatchObject({ detail: 'the evidence is not valid' });
  });
});
