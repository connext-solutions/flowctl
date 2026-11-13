import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import dayjs from 'dayjs';
import { describe, expect, it } from 'vitest';
import {
  FlowError,
  SourceRefSchema,
  claimsDerivation,
  deepExpand,
  loadFlow,
  updateLocators,
  withoutSourceRef,
  type Assertion,
} from '../src/flow/index.js';
import { parseExploreRequest } from '../src/explore/index.js';

const HEX = 'a'.repeat(64);
const SPEC = {
  kind: 'spec',
  ref: 'doc#fr-1',
  quote: 'The total is 5 {{items}}',
  quoteSha256: HEX,
  contextSha256: HEX,
  revision: 3,
};

describe('SourceRefSchema', () => {
  it('accepts a full spec reference and a minimal reference of another kind', () => {
    expect(SourceRefSchema.safeParse(SPEC).success).toBe(true);
    for (const kind of ['contract', 'invariant', 'baseline'])
      expect(SourceRefSchema.safeParse({ kind, ref: 'x' }).success).toBe(true);
  });

  it.each(['quote', 'quoteSha256', 'contextSha256', 'revision'])(
    'refuses a spec reference without %s',
    (field) => {
      const { [field]: _gone, ...rest } = SPEC as Record<string, unknown>;
      expect(SourceRefSchema.safeParse(rest).success).toBe(false);
    },
  );

  it('is strict, with a closed kind list', () => {
    expect(SourceRefSchema.safeParse({ ...SPEC, extra: 1 }).success).toBe(
      false,
    );
    expect(SourceRefSchema.safeParse({ kind: 'model', ref: 'x' }).success).toBe(
      false,
    );
  });

  it('wants 64 lowercase hex digests, a non-negative integer revision and a capped quote', () => {
    for (const bad of [
      { quoteSha256: 'A'.repeat(64) },
      { contextSha256: 'abc' },
      { revision: -1 },
      { revision: 1.5 },
      { quote: 'x'.repeat(501) },
    ])
      expect(SourceRefSchema.safeParse({ ...SPEC, ...bad }).success).toBe(
        false,
      );
  });

  it('accepts author and review as recorded metadata', () => {
    const r = SourceRefSchema.safeParse({
      kind: 'contract',
      ref: 'x',
      author: 'agent',
      review: 'unreviewed',
    });
    expect(r.success).toBe(true);
  });
});

const flowText = (extra: string, ref: string): string => `name: sr
goal: g
profile: employee
start: /x
${extra}steps:
  - click: { testId: go }
assertions:
  - text: "Total"
${ref}`;
const REF = `    sourceRef: { kind: contract, ref: c1, quote: "a {{ b" }\n`;

function write(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-sr-'));
  const file = join(dir, 'sr.yaml');
  writeFileSync(file, body);
  return file;
}

describe('loadFlow and derivation markers', () => {
  it('loads a plain flow with neither marker nor sourceRef', () => {
    const f = loadFlow(write(flowText('', '')), ['employee']);
    expect(claimsDerivation(f)).toBe(false);
  });

  it('refuses a sourceRef in a flow that is not marked derived', () => {
    expect(() => loadFlow(write(flowText('', REF)), ['employee'])).toThrow(
      /sourceRef.*derived|derived.*sourceRef/s,
    );
    expect(() =>
      loadFlow(write(flowText('derived: false\n', REF)), ['employee']),
    ).toThrow(FlowError);
  });

  it('loads a derived flow with sourceRefs and counts it as a claim', () => {
    const f = loadFlow(write(flowText('derived: true\n', REF)), ['employee']);
    expect(claimsDerivation(f)).toBe(true);
  });

  it('counts derived: true alone as a claim', () => {
    const f = loadFlow(write(flowText('derived: true\n', '')), ['employee']);
    expect(claimsDerivation(f)).toBe(true);
  });

  it('treats "{{" inside a quote as inert text: not a template error, never expanded', () => {
    const f = loadFlow(write(flowText('derived: true\n', REF)), ['employee']);
    const stripped = deepExpand(f.assertions.map(withoutSourceRef), {
      uid: 'u',
      now: dayjs(),
      vars: {},
    });
    expect(JSON.stringify(stripped)).not.toContain('a {{ b');
    const kept = f.assertions[0] as { sourceRef?: { quote?: string } };
    expect(kept.sourceRef?.quote).toBe('a {{ b');
  });

  it('keeps sourceRef bytes untouched when a locator is written back', () => {
    const file = write(flowText('derived: true\n', REF));
    updateLocators(file, new Map([[0, { testId: 'other' }]]));
    expect(readFileSync(file, 'utf8')).toContain(
      'sourceRef: { kind: contract, ref: c1, quote: "a {{ b" }',
    );
  });
});

describe('withoutSourceRef', () => {
  it('drops the reference and keeps the assertion', () => {
    const a: Assertion = {
      text: 'x',
      sourceRef: { kind: 'baseline', ref: 'b' },
    };
    expect(withoutSourceRef(a)).toEqual({ text: 'x' });
  });
});

describe('the exploration edge', () => {
  it('refuses a sourceRef an agent sends: it cannot declare its own provenance', () => {
    expect(() =>
      parseExploreRequest({
        goal: 'g',
        start: '/x',
        profile: 'employee',
        assertions: [{ text: 'x', sourceRef: { kind: 'baseline', ref: 'b' } }],
      }),
    ).toThrow(FlowError);
  });
});
