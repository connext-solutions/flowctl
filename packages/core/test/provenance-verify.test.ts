import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authenticRecords,
  checkApprovals,
  flowContentHash,
  highestRevision,
  provenanceState,
  requiredRevision,
  writeApprovals,
} from '../src/provenance/index.js';
import { revokeReviewerKey } from '../src/trust/index.js';
import {
  AT,
  FLOW_YAML,
  newReviewer,
  testOwnerKey,
  world,
  type World,
} from './approval-fixture.js';
import { editStore } from './trust-fixture.js';

const KEY = 'test-project/pv';

function check(
  w: World,
  records: unknown[],
  extra: {
    mergeBaseRevision?: number;
    hasDuplicateStem?: boolean;
    now?: Date;
    flow?: World['flow'];
  } = {},
) {
  const flow = extra.flow ?? w.flow;
  writeApprovals(flow.file, records);
  return checkApprovals(flow, {
    project: 'test-project',
    store: w.reload(),
    now: extra.now ?? AT,
    ...extra,
  });
}

describe('requiredRevision (ADR 0020 section l)', () => {
  it('is the maximum of the sources that exist, absent when none does', () => {
    expect(requiredRevision({})).toEqual({ rollbackNotChecked: true });
    expect(requiredRevision({ floor: 4 })).toEqual({
      required: 4,
      rollbackNotChecked: false,
    });
    expect(requiredRevision({ floor: 4, latest: 6, mergeBase: 5 })).toEqual({
      required: 6,
      rollbackNotChecked: false,
    });
    expect(requiredRevision({ mergeBase: 2 }).rollbackNotChecked).toBe(false);
  });
});

describe('checkApprovals: the floor table', () => {
  it('verifies with rollback_not_checked when the store has no value', () => {
    const w = world();
    const r = check(w, [w.record()]);
    expect(r.verified).toBe(true);
    expect(r.notes).toContain('rollback_not_checked');
  });

  it.each<[string, { floor: number; latest?: number }, number, boolean]>([
    ['floor 4, record 4', { floor: 4 }, 4, true],
    ['floor 4, record 3', { floor: 4 }, 3, false],
    ['floor 4, latest 6, record 5', { floor: 4, latest: 6 }, 5, false],
    ['floor 4, latest 6, record 6', { floor: 4, latest: 6 }, 6, true],
  ])('%s', (_n, stored, revision, ok) => {
    const w = world();
    editStore(w.store.dir, (d) => ({
      ...d,
      flowFloors: { [KEY]: stored.floor },
      latestRevision: Object.fromEntries(
        stored.latest === undefined ? [] : [[KEY, stored.latest]],
      ),
    }));
    const r = check(w, [w.record({ revision })]);
    expect(r.verified).toBe(ok);
    expect(r.notes.includes('revision_below_floor')).toBe(!ok);
    expect(r.notes).not.toContain('rollback_not_checked');
  });

  it('takes the merge-base value as a third term', () => {
    const w = world();
    const r = check(w, [w.record({ revision: 2 })], { mergeBaseRevision: 3 });
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('revision_below_floor');
  });
});

describe('checkApprovals: which records count (ADR 0020 section j)', () => {
  it('ignores a record of another flow name after a rename', () => {
    const w = world();
    const renamed = w.write('pw', FLOW_YAML('pw'));
    const r = check(w, [w.record()], { flow: renamed });
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('record_flow_mismatch');
  });

  it('refuses a copy under another stem', () => {
    const w = world();
    const copy = {
      ...w.flow,
      file: w.flow.file.replace('pv.yaml', 'copy.yaml'),
    };
    const r = check(w, [w.record()], { flow: copy });
    expect(r).toEqual({ verified: false, notes: ['flow_name_mismatch'] });
  });

  it('refuses a duplicate stem', () => {
    const w = world();
    expect(check(w, [w.record()], { hasDuplicateStem: true }).notes).toEqual([
      'flow_name_duplicate',
    ]);
  });

  it('ignores a record of another project', () => {
    const w = world();
    const r = check(w, [w.record({ project: 'other' })]);
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('record_project_mismatch');
  });

  it('ignores a record whose content hash is not the flow', () => {
    const w = world();
    const changed = w.write(
      'pv',
      FLOW_YAML('pv').replace('goal: g', 'goal: h'),
    );
    const old = w.record();
    const r = check(w, [old], { flow: changed });
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('record_hash_mismatch');
  });

  it.each([0, -1, 1.5, 9007199254740992])(
    'ignores revision %s and notes it',
    (revision) => {
      const w = world();
      const r = check(w, [w.record({ revision })]);
      expect(r.verified).toBe(false);
      expect(r.notes).toContain('revision_out_of_range');
    },
  );

  it('ignores a key that is revoked, expired, of the wrong scope or unknown', () => {
    const w = world();
    const revoked = newReviewer(w.store);
    revokeReviewerKey(w.reload(), testOwnerKey(), revoked.keyId, 'lost', AT);
    const spec = newReviewer(w.reload(), 'spec');
    const stranger = { ...w.signer, keyId: 'a'.repeat(64) };
    const cases: [string, ReturnType<World['record']>][] = [
      ['record_key_revoked', w.record({}, revoked)],
      ['record_key_wrong_scope', w.record({}, spec)],
      ['record_key_unknown', w.record({ keyId: stranger.keyId })],
    ];
    for (const [note, rec] of cases) {
      const r = check(w, [rec]);
      expect(r.verified).toBe(false);
      expect(r.notes).toContain(note);
    }
    const late = check(w, [w.record()], {
      now: new Date('2026-03-01T00:00:00.000Z'),
    });
    expect(late.verified).toBe(false);
    expect(late.notes).toContain('record_key_expired');
  });

  it('ignores a bad signature without selecting or blocking, and it cannot raise H', () => {
    const w = world();
    const good = w.record({ revision: 2 });
    const forged = {
      ...w.record({ revision: 9007199254740991 }),
      signature: good.signature,
    };
    const r = check(w, [good, forged]);
    expect(r.verified).toBe(true);
    expect(r.notes).toContain('signature_invalid');
    const ctx = {
      project: 'test-project',
      flow: w.flow,
      flowHash: flowContentHash(w.flow),
      store: w.reload(),
      now: AT,
    };
    expect(highestRevision(authenticRecords(ctx, [good, forged]).records)).toBe(
      2,
    );
  });

  it('notes a signature that is too long or a record that is malformed', () => {
    const w = world();
    expect(
      check(w, [{ ...w.record(), signature: 'A'.repeat(300) }]).notes,
    ).toContain('signature_too_large');
    expect(check(w, [{ nope: 1 }, 'x', null]).notes).toContain(
      'record_malformed',
    );
  });

  it('verifies two valid records at the highest revision that agree, and refuses ones that disagree', () => {
    const w = world();
    const second = newReviewer(w.store);
    const agree = check(w, [
      w.record({ revision: 3 }),
      w.record({ revision: 3 }, second),
    ]);
    expect(agree.verified).toBe(true);
    const number = { label: 'Total', unit: 'VND' };
    const assertions = w.record().assertions.map((a) => ({ ...a, number }));
    const differ = check(w, [
      w.record({ revision: 3 }),
      w.record({ revision: 3, assertions }, second),
    ]);
    expect(differ.verified).toBe(false);
    expect(differ.notes).toContain('record_tie_conflict');
    const baseline = check(w, [
      w.record({ revision: 3, baseline: { value: '1', evidence: 'e' } }),
      w.record(
        { revision: 3, baseline: { value: '2', evidence: 'e' } },
        second,
      ),
    ]);
    expect(baseline.notes).toContain('record_tie_conflict');
  });

  it('lets a lower record stay out of a tie at a higher revision', () => {
    const w = world();
    expect(
      check(w, [w.record({ revision: 1 }), w.record({ revision: 2 })]).verified,
    ).toBe(true);
  });

  it('refuses a file of more than 256 records', () => {
    const w = world();
    const records = Array.from({ length: 257 }, () => w.record());
    expect(() => writeApprovals(w.flow.file, records)).toThrow(/at most 256/);
    writeFileSync(
      w.flow.file.replace(/\.yaml$/, '.approvals.json'),
      JSON.stringify(records),
    );
    const r = checkApprovals(w.flow, {
      project: 'test-project',
      store: w.reload(),
      now: AT,
    });
    expect(r).toEqual({ verified: false, notes: ['approvals_too_large'] });
  });

  it('is unverified with signature_unavailable when there is no record', () => {
    const w = world();
    expect(check(w, []).notes).toEqual(['signature_unavailable']);
  });
});

describe('provenanceState with verify options', () => {
  it('is verified for a claim with a valid record, and unverified without one', () => {
    const w = world();
    writeApprovals(w.flow.file, [w.record()]);
    const verify = { project: 'test-project', store: w.reload(), now: AT };
    const ok = provenanceState(w.flow, w.flowsPath, w.store, verify);
    expect(ok.state).toBe('verified');
    expect(ok.notes).toContain('freshness_not_checked');
    writeApprovals(w.flow.file, [w.record({ revision: 0 })]);
    expect(provenanceState(w.flow, w.flowsPath, w.store, verify).state).toBe(
      'unverified',
    );
  });

  it('stays the stub without verify options: a valid record alone never verifies', () => {
    const w = world();
    writeApprovals(w.flow.file, [w.record()]);
    expect(provenanceState(w.flow, w.flowsPath, w.store).state).toBe(
      'unverified',
    );
  });
});
