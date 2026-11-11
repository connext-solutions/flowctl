import { describe, expect, it } from 'vitest';
import {
  buildCodeIndex,
  type CodeIndex,
  lex,
  MAX_ROUTE_SEGMENTS,
  messagesInSource,
} from '../../src/reconcile/index.js';
import { openRoot } from '../../src/trust/index.js';
import { put, tmp } from './repo.js';

/** About 1 MiB, under the default per-file cap so the build reads it. */
const SIZE = 1_000_000;
/** Wall-clock budget for one hostile input; generous, a linear pass takes tens of milliseconds. */
const BUDGET_MS = 1_000;

/** Runs `fn` and returns its result with the milliseconds it took. */
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
};

/** Indexes a repository holding only `file` with `body`, timed. */
const indexOne = (
  file: string,
  body: string,
): { value: CodeIndex; ms: number } => {
  const dir = tmp();
  put(dir, file, body);
  return timed(() => buildCodeIndex(openRoot(dir, 'repos')));
};

const ZOD = "import { z } from 'zod';\n";

describe('hostile input stays linear (ADR 0035 decision 4)', () => {
  it('JSX routes nested a million bytes deep', () => {
    const unit = '<Route path="a">';
    const { value, ms } = indexOne(
      'src/a.tsx',
      unit.repeat(SIZE / unit.length),
    );
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.routes).toHaveLength(MAX_ROUTE_SEGMENTS);
    expect(value.skipped).toEqual([
      { path: 'src/a.tsx', line: 1, rule: 'route too deep' },
    ]);
  });

  it('route objects nested a million bytes deep', () => {
    const unit = "{path:'a',children:[";
    const body = `createBrowserRouter([${unit.repeat(SIZE / unit.length)}`;
    const { value, ms } = indexOne('src/router.ts', body);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.routes).toHaveLength(MAX_ROUTE_SEGMENTS);
    expect(value.skipped.map((s) => s.rule)).toEqual(['route too deep']);
  });

  it('many children under one very long parent path', () => {
    const body = `<Route path="${'a/'.repeat(5_000)}">${'<Route path="b" />'.repeat(50_000)}</Route>`;
    const { value, ms } = indexOne('src/a.tsx', body);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.routes).toEqual([]);
    expect(value.skipped).toEqual([
      { path: 'src/a.tsx', line: 1, rule: 'route too long' },
    ]);
  });

  it('an unterminated string of escaped quotes', () => {
    const { value, ms } = timed(() => lex(`'${"\\'".repeat(SIZE / 2)}`));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.filter((t) => t.type === 'str')).toEqual([]);
  });

  it('unterminated regular expression classes', () => {
    const { ms } = timed(() => lex(`x=${'/['.repeat(SIZE / 2)}`));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('strings with an unclosed \\u{ escape', () => {
    const { value, ms } = timed(() => lex('"\\u{"'.repeat(SIZE / 5)));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value).toHaveLength(SIZE / 5);
  });

  it('a chain of nested validator calls', () => {
    const src = `${ZOD}${'x.min('.repeat(SIZE / 6)}'deep'`;
    const { ms } = timed(() => messagesInSource('a.ts', src));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
