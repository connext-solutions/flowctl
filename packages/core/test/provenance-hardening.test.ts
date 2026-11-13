import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LoadedConfig, ResolvedEnv } from '../src/index.js';
import type { ProvenanceStateName, RunProvenance } from '../src/index.js';
import { SourceRefSchema, loadFlow } from '../src/flow/index.js';
import { confirmInputFor } from '../src/run/index.js';
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

describe('labelFlow never fails a replay', () => {
  const broken = {
    get data(): never {
      throw new Error('boom');
    },
  } as unknown as TrustStore;

  it('falls back to unclassified with a note when the store cannot be read', () => {
    const { file, root } = setup(body());
    const r = labelFlow(loadFlow(file, ['employee']), root, broken);
    expect(r.state).toBe('unclassified');
    expect(r.notes).toContain('classification_unreadable');
  });

  it('keeps a derivation claim unverified', () => {
    const { file, root } = setup(body('derived: true\n'));
    const r = labelFlow(loadFlow(file, ['employee']), root, broken);
    expect(r.state).toBe('unverified');
  });
});

describe('the label binds to the bytes loadFlow parsed', () => {
  it('is unclassified with a note when the file changed after it was loaded', () => {
    const listed = setup(body('', '  - text: "Other"\n'));
    const digest = handWrittenDigest(
      loadFlow(listed.file, ['employee']),
      listed.root,
    );
    const { file, root } = setup(body());
    const parsed = loadFlow(file, ['employee']);
    writeFileSync(file, body('', '  - text: "Other"\n'));
    const r = provenanceState(
      parsed,
      root,
      storeWith({ path: 'pv.yaml', closureDigest: digest }),
    );
    expect(r.state).toBe('unclassified');
    expect(r.notes).toContain('flow_file_changed');
    expect(handWrittenDigest(parsed, root)).toBe('');
  });

  it('still lists an unchanged flow', () => {
    const { file, root } = setup(body());
    const flow = loadFlow(file, ['employee']);
    const digest = handWrittenDigest(flow, root);
    const r = provenanceState(
      flow,
      root,
      storeWith({ path: 'pv.yaml', closureDigest: digest }),
    );
    expect(r.state).toBe('hand-written');
    expect(r.notes).toContain('handwritten_entry_unsigned');
  });
});

describe('sourceRef text fields', () => {
  it.each([
    ['ref', 'r'.repeat(501)],
    ['author', 'a'.repeat(501)],
    ['ref', 'a\nb'],
    ['author', 'a\u001b[31mb'],
    ['ref', 'a\u0000b'],
  ])('refuses a bad %s', (field, value) => {
    const r = SourceRefSchema.safeParse({
      kind: 'contract',
      ref: 'x',
      [field]: value,
    });
    expect(r.success).toBe(false);
  });

  it('accepts a ref at the cap', () => {
    expect(
      SourceRefSchema.safeParse({ kind: 'contract', ref: 'r'.repeat(500) })
        .success,
    ).toBe(true);
  });
});

describe('confirmInputFor ignores sourceRef quotes', () => {
  it('does not read env references out of a quote', () => {
    const { file, root } = setup(
      body(
        'derived: true\n',
        '  - text: "Total"\n    sourceRef: { kind: contract, ref: c1, quote: "{{env.SECRET}}" }\n',
      ),
    );
    const flow = loadFlow(file, ['employee']);
    const cfg = { flowsPath: root } as unknown as LoadedConfig;
    const env = { vars: { SECRET: 's' } } as unknown as ResolvedEnv;
    expect(confirmInputFor(cfg, flow, env).vars).toEqual({});
  });
});

describe('exported provenance types', () => {
  it('are reachable from the package index', () => {
    const s: ProvenanceStateName = 'unclassified';
    const p: RunProvenance = { state: s, notes: [] };
    expect(p.state).toBe('unclassified');
  });
});
