import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadFlow } from '../src/flow/index.js';
import {
  handWrittenDigest,
  labelFlow,
  provenanceState,
  type ProvenanceStore,
} from '../src/provenance/index.js';
import type { TrustStore } from '../src/trust/index.js';

const body = (
  extra = '',
  assertion = '  - text: "Total"\n',
): string => `name: pv
goal: g
profile: employee
start: /x
${extra}steps:
  - click: { testId: go }
assertions:
${assertion}`;

function setup(text: string): { file: string; root: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-pvh-'));
  const root = join(dir, 'flows');
  mkdirSync(root);
  const file = join(root, 'pv.yaml');
  writeFileSync(file, text);
  return { file, root };
}

const storeWith = (...entries: unknown[]): ProvenanceStore => ({
  data: { handWritten: entries },
});

describe('labelling reads the flow file hash once', () => {
  it('never reaches hand-written when a read flips between checks', async () => {
    const { file, root } = setup(body());
    const flow = loadFlow(file, ['employee']);
    const digest = handWrittenDigest(flow, root);
    const { snapshotFlowFile } = await import('../src/provenance/index.js');
    const good = snapshotFlowFile(flow, root);
    const store = storeWith({ path: 'pv.yaml', closureDigest: digest });
    // A snapshot that differs from sourceSha256 is changed, not listed.
    const bad = { sha256: 'f'.repeat(64) };
    const { flowFileChanged, listedHandWritten } =
      await import('../src/provenance/index.js');
    expect(flowFileChanged(flow, root, bad)).toBe(true);
    expect(listedHandWritten(flow, root, store, bad)).toBe(false);
    expect(listedHandWritten(flow, root, store, { sha256: undefined })).toBe(
      false,
    );
    expect(listedHandWritten(flow, root, store, good)).toBe(true);
  });

  it('hashes the file once per labelling', async () => {
    const { file, root } = setup(body());
    const flow = loadFlow(file, ['employee']);
    const digest = handWrittenDigest(flow, root);
    const spy = vi.spyOn(await import('../src/trust/index.js'), 'hashFlowFile');
    spy.mockClear();
    const r = provenanceState(
      flow,
      root,
      storeWith({ path: 'pv.yaml', closureDigest: digest }),
    );
    expect(r.state).toBe('hand-written');
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('is unclassified when the first read is fine and a later one would differ', () => {
    const { file, root } = setup(body());
    const flow = loadFlow(file, ['employee']);
    const digest = handWrittenDigest(flow, root);
    const r = provenanceState(
      { ...flow, sourceSha256: 'e'.repeat(64) },
      root,
      storeWith({ path: 'pv.yaml', closureDigest: digest }),
    );
    expect(r.state).toBe('unclassified');
    expect(r.notes).toContain('flow_file_changed');
  });
});

describe('errorClass never throws', () => {
  const labelWith = (thrown: unknown) => {
    const store = {
      get data(): never {
        throw thrown;
      },
    } as unknown as TrustStore;
    const { file, root } = setup(body());
    return labelFlow(loadFlow(file, ['employee']), root, store).notes;
  };

  it.each([
    ['a string', 'boom'],
    ['null', null],
    ['an object', { name: 'X' }],
    ['a number', 7],
  ])('says Unknown for %s', (_n, thrown) => {
    expect(labelWith(thrown)).toContain('classification_unreadable:Unknown');
  });

  it('says Unknown for an error whose constructor lookup throws', () => {
    const e = new Error('x');
    Object.defineProperty(e, 'constructor', {
      get(): never {
        throw new Error('nope');
      },
    });
    expect(labelWith(e)).toContain('classification_unreadable:Unknown');
  });

  it('says Unknown for an error with an odd or missing constructor name', () => {
    const odd = new Error('x');
    Object.defineProperty(odd, 'constructor', { value: { name: '/p ath' } });
    expect(labelWith(odd)).toContain('classification_unreadable:Unknown');
    const none = Object.assign(new Error('x'), { constructor: undefined });
    expect(labelWith(none)).toContain('classification_unreadable:Unknown');
  });
});
