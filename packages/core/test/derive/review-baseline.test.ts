import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { approveCase } from '../../src/derive/review/index.js';
import {
  approvalsPath,
  ApprovalError,
  checkApprovals,
} from '../../src/provenance/index.js';
import { TrustError } from '../../src/trust/index.js';
import { AT, FLOW_YAML, world, type World } from '../approval-fixture.js';
import { options } from './review-fixture.js';

const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TrustError) return e.kind;
    if (e instanceof ApprovalError) return e.code;
    throw e;
  }
  return 'none';
};

const BASELINE_YAML = FLOW_YAML('pv')
  .replace('text: "Total"', 'text: "999"')
  .replace('kind: invariant, ref: inv-1', 'kind: baseline, ref: b-1');

function baselineWorld(): { w: World; flow: World['flow'] } {
  const w = world();
  return { w, flow: w.write('pv', BASELINE_YAML) };
}

const seen = (...values: string[]) => ({
  passed: true,
  summary: { n: values.length },
  baselineSeen: values,
});

describe('approveCase: the baseline is bound to the flow', () => {
  it('signs the value the flow asserts when the replays showed it', async () => {
    const { w, flow } = baselineWorld();
    const r = await approveCase(
      options(w, {
        flow,
        baseline: { value: '999', evidence: 'page showed 999' },
        replay: seen('41', '999'),
      }).opts,
    );
    expect(r.record.baseline).toEqual({
      value: '999',
      evidence: 'page showed 999',
    });
    const check = checkApprovals(flow, {
      project: 'test-project',
      store: w.reload(),
      now: AT,
    });
    expect(check.verified).toBe(true);
  });

  it('refuses a value the flow does not assert, before any replay', async () => {
    const { w, flow } = baselineWorld();
    const { opts, calls } = options(w, {
      flow,
      baseline: { value: '42', evidence: 'e' },
      replay: seen('42', '999'),
    });
    expect(await refusal(approveCase(opts))).toBe('baseline_mismatch');
    expect(calls.replays).toBe(0);
    expect(existsSync(approvalsPath(flow.file))).toBe(false);
  });

  it('refuses a flow with a baseline assertion and no baseline to approve', async () => {
    const { w, flow } = baselineWorld();
    const { opts, calls } = options(w, { flow, replay: seen('999') });
    expect(await refusal(approveCase(opts))).toBe('baseline_required');
    expect(calls.replays).toBe(0);
  });

  it('refuses a baseline for a flow that asserts none', async () => {
    const w = world();
    const { opts } = options(w, {
      baseline: { value: 'Total', evidence: 'e' },
      replay: seen('Total'),
    });
    expect(await refusal(approveCase(opts))).toBe('baseline_mismatch');
  });

  it('takes the observed values from its own replays and the map, never from the caller', async () => {
    const { w, flow } = baselineWorld();
    const unseen = options(w, {
      flow,
      baseline: { value: '999', evidence: 'e' },
      replay: seen('41'),
    });
    expect(await refusal(approveCase(unseen.opts))).toBe('baseline_mismatch');
    expect(unseen.calls.unlocks).toEqual([]);
    const inMap = options(w, {
      flow,
      baseline: { value: '999', evidence: 'e' },
      replay: { passed: true, summary: {} },
      appMapEvidence: { pages: [{ texts: ['999'] }] },
    });
    expect((await approveCase(inMap.opts)).record.baseline?.value).toBe('999');
  });

  it('refuses two baseline assertions and a baseline with no checked value', async () => {
    const two = world();
    const twice = two.write(
      'pv',
      `${BASELINE_YAML}  - text: "998"\n    sourceRef: { kind: baseline, ref: b-2 }\n`,
    );
    expect(
      await refusal(
        approveCase(
          options(two, {
            flow: twice,
            baseline: { value: '999', evidence: 'e' },
            replay: seen('999', '998'),
          }).opts,
        ),
      ),
    ).toBe('baseline_unsupported');
    const none = world();
    const console = none.write(
      'pv',
      BASELINE_YAML.replace('text: "999"', 'noConsoleErrors: true'),
    );
    expect(
      await refusal(
        approveCase(
          options(none, {
            flow: console,
            baseline: { value: '999', evidence: 'e' },
          }).opts,
        ),
      ),
    ).toBe('baseline_unsupported');
  });
});
