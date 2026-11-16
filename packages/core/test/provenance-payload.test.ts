import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encodeApprovalPayload,
  flowContentHash,
  type ApprovalPayload,
} from '../src/provenance/index.js';
import { FLOW_YAML, HEX, world } from './approval-fixture.js';

const BASE: ApprovalPayload = {
  project: 'proj',
  flowName: 'flow-a',
  flowHash: HEX,
  revision: 3,
  keyId: 'd'.repeat(64),
  approvedAt: '2026-01-05T00:00:00.000Z',
  assertions: [
    {
      hash: 'e'.repeat(64),
      sourceRef: { kind: 'invariant', ref: 'inv-1' },
      polarity: 'positive',
      number: { label: 'Total', unit: 'VND' },
    },
  ],
  replayHashes: ['a'.repeat(64), 'b'.repeat(64)],
  evidenceHash: '1'.repeat(64),
  baseline: { value: '42', evidence: 'seen on the page' },
};

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

describe('encodeApprovalPayload (ADR 0042)', () => {
  it('matches a payload written out by hand: domain tag, version byte, length-prefixed fields', () => {
    const u32 = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32BE(n);
      return b;
    };
    const f = (s: string) =>
      Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
    const minimal: ApprovalPayload = {
      project: 'proj',
      flowName: 'flow-a',
      flowHash: HEX,
      revision: 7,
      keyId: 'd'.repeat(64),
      approvedAt: '2026-01-05T00:00:00.000Z',
      assertions: [],
      replayHashes: ['a'.repeat(64)],
      evidenceHash: '1'.repeat(64),
    };
    const expected = Buffer.concat([
      f('flowctl-case-approval/1'),
      Buffer.from([1]),
      f('proj'),
      f('flow-a'),
      f(HEX),
      f('7'),
      f('d'.repeat(64)),
      f('2026-01-05T00:00:00.000Z'),
      u32(0),
      u32(1),
      f('a'.repeat(64)),
      f('1'.repeat(64)),
      Buffer.from([0]),
    ]);
    expect(encodeApprovalPayload(minimal).toString('hex')).toBe(
      expected.toString('hex'),
    );
    expect(sha(expected)).toHaveLength(64);
  });

  const mutations: [string, ApprovalPayload][] = [
    ['project', { ...BASE, project: 'other' }],
    ['flowName', { ...BASE, flowName: 'flow-b' }],
    ['flowHash', { ...BASE, flowHash: 'f'.repeat(64) }],
    ['revision', { ...BASE, revision: 4 }],
    ['keyId', { ...BASE, keyId: '9'.repeat(64) }],
    ['approvedAt', { ...BASE, approvedAt: '2026-01-06T00:00:00.000Z' }],
    [
      'assertion hash',
      {
        ...BASE,
        assertions: [{ ...BASE.assertions[0]!, hash: '0'.repeat(64) }],
      },
    ],
    [
      'sourceRef',
      {
        ...BASE,
        assertions: [
          {
            ...BASE.assertions[0]!,
            sourceRef: { kind: 'invariant', ref: 'inv-2' },
          },
        ],
      },
    ],
    [
      'number',
      {
        ...BASE,
        assertions: [
          { ...BASE.assertions[0]!, number: { label: 'Total', unit: 'USD' } },
        ],
      },
    ],
    [
      'no number',
      {
        ...BASE,
        assertions: [
          {
            hash: 'e'.repeat(64),
            sourceRef: { kind: 'invariant', ref: 'inv-1' },
            polarity: 'positive',
          },
        ],
      },
    ],
    ['replay hash', { ...BASE, replayHashes: ['a'.repeat(64)] }],
    ['evidenceHash', { ...BASE, evidenceHash: '2'.repeat(64) }],
    [
      'baseline value',
      { ...BASE, baseline: { value: '43', evidence: 'seen on the page' } },
    ],
    [
      'baseline evidence',
      { ...BASE, baseline: { value: '42', evidence: 'seen' } },
    ],
    [
      'no baseline',
      {
        project: BASE.project,
        flowName: BASE.flowName,
        flowHash: BASE.flowHash,
        revision: 3,
        keyId: BASE.keyId,
        approvedAt: BASE.approvedAt,
        assertions: BASE.assertions,
        replayHashes: BASE.replayHashes,
        evidenceHash: BASE.evidenceHash,
      },
    ],
  ];
  it.each(mutations)('changes the bytes when %s changes', (_n, changed) => {
    expect(
      encodeApprovalPayload(changed).equals(encodeApprovalPayload(BASE)),
    ).toBe(false);
  });

  it('cannot shift a boundary between two fields', () => {
    const a = encodeApprovalPayload({ ...BASE, project: 'ab', flowName: 'c' });
    const b = encodeApprovalPayload({ ...BASE, project: 'a', flowName: 'bc' });
    expect(a.equals(b)).toBe(false);
  });

  it('refuses text that is not NFC or holds invisible code points', () => {
    const refuse = (baseline: { value: string; evidence: string }) =>
      expect(() => encodeApprovalPayload({ ...BASE, baseline })).toThrow(
        /NFC|invisible/,
      );
    refuse({ value: 'é', evidence: 'x' });
    refuse({ value: 'a‮b', evidence: 'x' });
    refuse({ value: 'x', evidence: 'a\nb' });
  });
});

describe('flowContentHash', () => {
  it('ignores key order and file layout, and changes with any content', () => {
    const w = world();
    const same = w.write(
      'pv',
      FLOW_YAML('pv').replace(
        'goal: g\nprofile: employee',
        'profile: employee\ngoal: g',
      ),
    );
    expect(flowContentHash(same)).toBe(flowContentHash(w.flow));
    for (const [from, to] of [
      ['goal: g', 'goal: h'],
      ['testId: go', 'testId: stop'],
      ['"Total"', '"Totals"'],
      ['inv-1', 'inv-2'],
      ['start: /x', 'start: /y'],
    ] as const) {
      const changed = w.write('pv', FLOW_YAML('pv').replace(from, to));
      expect(flowContentHash(changed)).not.toBe(flowContentHash(w.flow));
    }
    const hooked = w.write(
      'pv',
      FLOW_YAML('pv', '').replace('start: /x', 'start: /x\nsetup: hooks/up.sh'),
    );
    expect(flowContentHash(hooked)).not.toBe(flowContentHash(w.flow));
  });
});
