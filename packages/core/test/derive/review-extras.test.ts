import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  approveCase,
  pruneApprovals,
  rejectPreApproved,
  verifyBaseline,
  baselineCount,
} from '../../src/derive/review/index.js';
import {
  approvalsPath,
  ApprovalError,
  writeApprovals,
} from '../../src/provenance/index.js';
import { revokeReviewerKey } from '../../src/trust/index.js';
import {
  AT,
  FLOW_YAML,
  newReviewer,
  testOwnerKey,
  world,
} from '../approval-fixture.js';
import { options } from './review-fixture.js';

describe('baselines', () => {
  it('signs an approved value the evidence showed, and refuses one it did not', async () => {
    const w = world();
    const flow = w.write(
      'pv',
      FLOW_YAML('pv').replace(
        'kind: invariant, ref: inv-1',
        'kind: baseline, ref: b-1',
      ),
    );
    const baseline = { value: 'Total', evidence: 'page showed Total' };
    const shown = { passed: true, summary: {}, baselineSeen: ['Total'] };
    const r = await approveCase(
      options(w, { flow, baseline, replay: shown }).opts,
    );
    expect(r.record.baseline).toEqual(baseline);
    expect(baselineCount(flow)).toBe(1);
    expect(() => verifyBaseline('Total', ['Totals'])).toThrow(/not among/);
    expect(() => verifyBaseline('Total', ['x', 'Total'])).not.toThrow();
  });

  it('rejects generator output that already holds a baseline or an approval', () => {
    expect(() =>
      rejectPreApproved({ assertions: [{ sourceRef: { kind: 'baseline' } }] }),
    ).toThrow(ApprovalError);
    expect(() =>
      rejectPreApproved({ assertions: [], approvals: [{}] }),
    ).toThrow(ApprovalError);
    expect(() =>
      rejectPreApproved({ assertions: [{ sourceRef: { kind: 'spec' } }] }),
    ).not.toThrow();
  });
});

describe('prune', () => {
  it('removes records of revoked keys and other hashes, signs nothing, and repairs a full file', async () => {
    const w = world();
    const second = newReviewer(w.store);
    const changed = w.write(
      'pv',
      FLOW_YAML('pv').replace('goal: g', 'goal: h'),
    );
    const stale = w.record({}, w.signer, w.flow);
    writeApprovals(changed.file, [
      stale,
      w.record({}, second, changed),
      w.record({}, w.signer, changed),
    ]);
    revokeReviewerKey(w.reload(), testOwnerKey(), second.keyId, 'lost', AT);
    const r = pruneApprovals({
      flow: changed,
      project: 'test-project',
      store: w.reload(),
      now: AT,
    });
    expect(r).toEqual({ removed: 2, kept: 1 });
    const full = Array.from({ length: 256 }, () => stale);
    writeFileSync(approvalsPath(changed.file), JSON.stringify(full));
    const done = await approveCase(options(w, { flow: changed }).opts);
    expect(done.pruned).toBe(256);
    expect(
      JSON.parse(readFileSync(approvalsPath(changed.file), 'utf8')),
    ).toHaveLength(1);
  });

  it('drops forged records of a valid key at the current hash from a full file, and then approves', async () => {
    const w = world();
    const forged = {
      ...w.record({ revision: 5 }),
      signature: 'A'.repeat(86) + '==',
    };
    writeFileSync(
      approvalsPath(w.flow.file),
      JSON.stringify(Array.from({ length: 256 }, () => forged)),
    );
    const done = await approveCase(options(w).opts);
    expect(done.pruned).toBe(256);
    expect(done.revision).toBe(1);
    expect(
      JSON.parse(readFileSync(approvalsPath(w.flow.file), 'utf8')),
    ).toHaveLength(1);
    writeFileSync(
      approvalsPath(w.flow.file),
      JSON.stringify([forged, done.record]),
    );
    expect(
      pruneApprovals({
        flow: w.flow,
        project: 'test-project',
        store: w.reload(),
        now: AT,
      }),
    ).toEqual({ removed: 1, kept: 1 });
  });
});

describe('the review gate is not an MCP tool', () => {
  it('lists no tool that reviews or approves, and the derive barrel never exports saveAsGenerator', async () => {
    const { MCP_TOOLS } = await import('../../src/index.js');
    expect(MCP_TOOLS.filter((t) => /review|approv|sign/i.test(t))).toEqual([]);
    const barrel = readFileSync(
      new URL('../../src/derive/index.ts', import.meta.url),
      'utf8',
    );
    expect(barrel).not.toMatch(/saveAsGenerator/);
  });
});
