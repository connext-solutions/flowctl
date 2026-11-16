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
    expect(r.notes).toContain('classification_unreadable:Error');
  });

  it('names the error class but never its message', () => {
    class OddFailure extends Error {}
    const odd = {
      get data(): never {
        throw new OddFailure('/secret/path');
      },
    } as unknown as TrustStore;
    const { file, root } = setup(body());
    const r = labelFlow(loadFlow(file, ['employee']), root, odd);
    expect(r.notes).toContain('classification_unreadable:OddFailure');
    expect(r.notes.join(' ')).not.toContain('/secret/path');
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

  it('keeps a file that cannot be read apart from one whose bytes differ', () => {
    const { file, root } = setup(body());
    const parsed = loadFlow(file, ['employee']);
    writeFileSync(file, `${body()}# ${'x'.repeat(300 * 1024)}\n`);
    const r = provenanceState(parsed, root, storeWith());
    expect(r.state).toBe('unclassified');
    expect(r.notes).toContain('flow_file_unreadable');
    expect(r.notes).not.toContain('flow_file_changed');
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
    ['ref', 'a\u200eb'],
    ['author', 'a\u200fb'],
    ['ref', 'a\u061cb'],
    ['author', 'a\u2060b'],
    ['ref', 'a\u00adb'],
    ['author', 'a\u{e0041}b'],
    ['ref', 'a\u202eb'],
    ['author', 'a\u2028b'],
  ])('refuses an invisible code point in %s', (field, value) => {
    expect(
      SourceRefSchema.safeParse({ kind: 'contract', ref: 'x', [field]: value })
        .success,
    ).toBe(false);
  });

  it.each([
    '\u200e',
    '\u200f',
    '\u061c',
    '\u2060',
    '\u00ad',
    '\u{e0041}',
    '\u202e',
    '\u2028',
  ])('refuses U+%s in a quote', (ch) => {
    expect(
      SourceRefSchema.safeParse({
        kind: 'contract',
        ref: 'x',
        quote: `a${ch}b`,
      }).success,
    ).toBe(false);
  });

  it('keeps CRLF in a quote but refuses a lone carriage return', () => {
    const quote = (q: string) =>
      SourceRefSchema.safeParse({ kind: 'contract', ref: 'x', quote: q })
        .success;
    expect(quote('one\r\n\ttwo')).toBe(true);
    expect(quote('one\rtwo')).toBe(false);
  });

  it.each([
    ['ref', 'r'.repeat(501)],
    ['author', 'a'.repeat(501)],
    ['ref', 'a\nb'],
    ['author', 'a\u001b[31mb'],
    ['ref', 'a\u0000b'],
    ['ref', 'a\u202eb'],
    ['author', 'a\u2066b'],
    ['ref', 'a\u2028b'],
    ['author', 'a\u2029b'],
    ['ref', 'a\u200bb'],
    ['author', 'a\u200db'],
    ['ref', '\ufeffb'],
  ])('refuses a bad %s', (field, value) => {
    const r = SourceRefSchema.safeParse({
      kind: 'contract',
      ref: 'x',
      [field]: value,
    });
    expect(r.success).toBe(false);
  });

  it('refuses escape and other control characters in a quote but keeps newline and tab', () => {
    const quote = (q: string) =>
      SourceRefSchema.safeParse({ kind: 'contract', ref: 'x', quote: q })
        .success;
    expect(quote('a\u001b[31mb')).toBe(false);
    expect(quote('a\u0085b')).toBe(false);
    expect(quote('a\u0000b')).toBe(false);
    expect(quote('line one\n\tline two')).toBe(true);
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
