import { describe, expect, it } from 'vitest';
import { readFiles, reasons } from './contract-fixture.js';

const MIB = 1024 * 1024;
const LIMIT_MS = 2000;

/** Reads `files` and returns the report with the wall time of the read. */
function timed(
  files: Record<string, string>,
): ReturnType<typeof readFiles> & { ms: number } {
  const start = performance.now();
  const report = readFiles(files);
  return { ...report, ms: performance.now() - start };
}

describe('work is bounded before a file is parsed', () => {
  it('reads a megabyte of newlines or blanks quickly, with a typed skip when the file is a contract', () => {
    const marked = timed({
      'api.yaml': `openapi: 3.1.0\n${'\n'.repeat(MIB - 16)}`,
    });
    expect(marked.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(marked.skipped)).toEqual(['too_many_nodes']);
    const catalogue = timed({ 'i18n/vi.json': ' \n'.repeat(MIB / 2) });
    expect(catalogue.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(catalogue.skipped)).toEqual(['too_many_nodes']);
  });

  it('does not run a pattern over a megabyte of blanks in a file that is not a contract', () => {
    for (const body of [
      '\n'.repeat(MIB),
      ' \n'.repeat(MIB / 2),
      ' '.repeat(MIB),
    ])
      for (const name of ['x.yaml', 'x.yml', 'x.json']) {
        const r = timed({ [name]: body });
        expect(r.ms).toBeLessThan(LIMIT_MS);
        expect(r.facts).toEqual([]);
      }
  });

  it('reads a megabyte of near-matches in source and HTML quickly', () => {
    for (const [name, body] of [
      ['a.ts', 'z'.repeat(MIB)],
      ['b.ts', 'z '.repeat(MIB / 2)],
      ['c.ts', `z${' '.repeat(MIB - 1)}`],
      ['d.html', '<'.repeat(MIB)],
      ['e.html', '<a '.repeat(MIB / 3)],
    ] as const) {
      const r = timed({ [name]: body });
      expect(r.ms).toBeLessThan(LIMIT_MS);
      expect(r.facts).toEqual([]);
    }
  });

  it('refuses a very large mapping that repeats a key, in linear time', () => {
    const r = timed({
      'api.yaml': `openapi: 3.1.0\n${'a: 1\n'.repeat(190_000)}`,
    });
    expect(r.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(r.skipped)).toEqual(['yaml_invalid']);
  });

  it('reads a mapping of many distinct keys in linear time', () => {
    const keys = Array.from({ length: 100_000 }, (_, i) => `k${i}: 1`);
    const r = timed({ 'api.yaml': `openapi: 3.1.0\n${keys.join('\n')}\n` });
    expect(r.ms).toBeLessThan(LIMIT_MS);
    expect(r.skipped).toEqual([]);
  });

  it('refuses deep indentation and deep flow nesting before parsing', () => {
    const block = Array.from(
      { length: 1300 },
      (_, i) => `${' '.repeat(i)}k${i}:`,
    ).join('\n');
    const a = timed({ 'api.yaml': `openapi: 3.1.0\nx:\n${block}\n` });
    expect(a.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(a.skipped)).toEqual(['too_deep']);
    const flow = timed({
      'api.yaml': `openapi: 3.1.0\nx: ${'['.repeat(500_000)}`,
    });
    expect(flow.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(flow.skipped)).toEqual(['too_deep']);
    const json = timed({ 'i18n/vi.json': '{"a":'.repeat(100_000) });
    expect(json.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(json.skipped)).toEqual(['too_deep']);
  });

  it('refuses a file with too many separators without parsing it', () => {
    const commas = timed({ 'i18n/vi.json': `[${'1,'.repeat(300_000)}1]` });
    expect(commas.ms).toBeLessThan(LIMIT_MS);
    expect(reasons(commas.skipped)).toEqual(['too_many_nodes']);
  });
});
