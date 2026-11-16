import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  authenticRecords,
  checkApprovals,
  flowContentHash,
  highestRevision,
  writeApprovals,
  type ApprovedAssertion,
  type CaseApprovalRecord,
} from '../src/provenance/index.js';
import { revokeReviewerKey } from '../src/trust/index.js';
import {
  AT,
  FLOW_YAML,
  HEX,
  newReviewer,
  testOwnerKey,
  world,
  checkRecords as check,
  type World,
} from './approval-fixture.js';

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
    const flow = w.write(
      'pv',
      FLOW_YAML('pv').replace(
        'kind: invariant, ref: inv-1',
        'kind: baseline, ref: b-1',
      ),
    );
    const at3 = (value: string, as = w.signer) =>
      w.record({ revision: 3, baseline: { value, evidence: 'e' } }, as, flow);
    const bound = check(w, [at3('Total'), at3('Other', second)], { flow });
    expect(bound.verified).toBe(true);
    expect(bound.notes).toContain('record_baseline_mismatch');
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

type Edit = (r: CaseApprovalRecord, otherKey: string) => CaseApprovalRecord;
const mapAssertions = (
  r: CaseApprovalRecord,
  f: (a: ApprovedAssertion) => ApprovedAssertion,
): CaseApprovalRecord => ({ ...r, assertions: r.assertions.map(f) });
const baselineOf = (w: World) =>
  w.write('pv', FLOW_YAML('pv').replace('kind: invariant', 'kind: baseline'));

describe('checkApprovals: every signed field is bound by the signature', () => {
  const bl = { value: 'Total', evidence: 'e' };
  it.each<[string, Edit]>([
    ['approvedAt', (r) => ({ ...r, approvedAt: '2026-01-06T00:00:00.000Z' })],
    ['replayHashes', (r) => ({ ...r, replayHashes: [HEX] })],
    ['evidenceHash', (r) => ({ ...r, evidenceHash: HEX })],
    ['baseline.value', (r) => ({ ...r, baseline: { ...bl, value: 'Totals' } })],
    [
      'baseline.evidence',
      (r) => ({ ...r, baseline: { ...bl, evidence: 'f' } }),
    ],
    [
      'number',
      (r) =>
        mapAssertions(r, (a) => ({ ...a, number: { label: 'n', unit: 'u' } })),
    ],
    [
      'sourceRef',
      (r) =>
        mapAssertions(r, (a) => ({
          ...a,
          sourceRef: { kind: 'baseline' as const, ref: 'inv-2' },
        })),
    ],
    ['keyId', (r, other) => ({ ...r, keyId: other })],
    ['revision', (r) => ({ ...r, revision: 2 })],
    ['flowName', (r) => ({ ...r, flowName: 'pw' })],
    ['project', (r) => ({ ...r, project: 'other' })],
  ])('%s edited after signing is signature_invalid', (_field, edit) => {
    const w = world();
    const flow = baselineOf(w);
    const other = newReviewer(w.store).keyId;
    const good = w.record({ baseline: bl }, w.signer, flow);
    expect(check(w, [good], { flow }).verified).toBe(true);
    const r = check(w, [edit(good, other)], { flow });
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('signature_invalid');
  });

  it('ignores a signed record whose assertions or their sourceRef are not the flow', () => {
    const w = world();
    const wrongHash = w.record({
      assertions: [{ hash: HEX, polarity: 'positive' }],
    });
    const wrongRef = w.record({
      assertions: w.record().assertions.map((a) => ({
        ...a,
        sourceRef: { kind: 'invariant' as const, ref: 'inv-2' },
      })),
    });
    for (const rec of [wrongHash, wrongRef]) {
      const r = check(w, [rec]);
      expect(r.verified).toBe(false);
      expect(r.notes).toContain('record_assertions_mismatch');
    }
  });

  it('ignores a signed record whose baseline is not the flow baseline', () => {
    const w = world();
    const flow = baselineOf(w);
    const cases = [
      w.record({ baseline: { value: '42', evidence: 'e' } }, w.signer, flow),
      w.record({}, w.signer, flow),
    ];
    for (const rec of cases) {
      const r = check(w, [rec], { flow });
      expect(r.verified).toBe(false);
      expect(r.notes).toContain('record_baseline_mismatch');
    }
    const extra = check(w, [
      w.record({ baseline: { value: 'Total', evidence: 'e' } }),
    ]);
    expect(extra.notes).toContain('record_baseline_mismatch');
  });

  it('reads an approvedAt that is not a real instant as malformed', () => {
    const w = world();
    const r = check(w, [w.record({ approvedAt: '2026-02-30T00:00:00.000Z' })]);
    expect(r.verified).toBe(false);
    expect(r.notes).toContain('record_malformed');
  });
});
