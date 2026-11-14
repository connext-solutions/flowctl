import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTRACT_LIMITS } from '../../src/derive/index.js';

const DIR = fileURLToPath(
  new URL('../../src/derive/contract/', import.meta.url),
);
const sources = readdirSync(DIR)
  .filter((f) => f.endsWith('.ts'))
  .map(
    (f) =>
      [
        f,
        readFileSync(join(DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, ''),
      ] as const,
  );

const FORBIDDEN: readonly [string, RegExp][] = [
  ['dynamic import', /\bimport\s*\(/],
  ['require', /\brequire\s*\(/],
  ['createRequire', /\bcreateRequire\b/],
  ['eval', /\beval\s*\(/],
  ['Function constructor', /\bnew\s+Function\b|\bFunction\s*\(/],
  ['vm', /['"](?:node:)?vm['"]/],
  ['child_process', /child_process/],
  ['worker_threads', /worker_threads/],
  [
    'a compiled pattern from text',
    /\bnew\s+RegExp\s*\(\s*(?!`<\/\$\{name\}`|`\[\$\{INVISIBLE_CLASS\}\]`)/,
  ],
  ['the environment', /\bprocess\.env\b/],
  ['the clock', /\bDate\b|\bperformance\.now\b/],
  ['a network call', /\bfetch\s*\(|node:https?|node:net\b/],
  ['output', /\bconsole\./],
];

describe('the contract readers read static text only', () => {
  it('has source files to scan', () => {
    expect(sources.length).toBeGreaterThanOrEqual(15);
  });

  for (const [what, pattern] of FORBIDDEN)
    it(`use no ${what}`, () => {
      const hits = sources
        .filter(([, text]) => pattern.test(text))
        .map(([f]) => f);
      expect(hits).toEqual([]);
    });

  it('open no file except through the containment helper', () => {
    const direct = sources
      .filter(([, t]) =>
        /readFileSync|openSync|readdirSync|createReadStream/.test(t),
      )
      .map(([f]) => f);
    expect(direct).toEqual([]);
  });
});

describe('limits', () => {
  it('are finite, positive integers', () => {
    for (const [name, v] of Object.entries(CONTRACT_LIMITS)) {
      expect(Number.isInteger(v) && v > 0, name).toBe(true);
    }
  });

  it('keep the depth of a parsed document below what a recursive walk can overflow', () => {
    expect(CONTRACT_LIMITS.maxDepth).toBeLessThanOrEqual(256);
  });
});
