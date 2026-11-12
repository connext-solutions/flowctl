import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureOutput,
  controls,
  io,
  project,
  reconcile,
  saveRun,
} from './reconcile-helpers.js';

/** `flowctl reconcile` (T6.6) on hand-written run directories: output, exit codes and terminal safety. */
captureOutput();

describe('flowctl reconcile <run id>', () => {
  it('prints the class, the confidence and each basis hit with its evidence, escaped, and exits 0', async () => {
    const p = project();
    saveRun(p, 'r_t1', {
      flow: 'sub\u001b]0;pwned\u0007mit',
      evidence: {
        dir: 'x',
        traces: [],
        console: [],
        network: ['503 GET http://127.0.0.1:9/api/\u001b[2J\u009b31m {}'],
      },
    });
    expect(await reconcile(p, 'r_t1')).toBe(0);
    const text = io.out.join('');
    expect(text).toMatch(
      /^Run r_t1 \(flow sub\\u\{001B\}\]0;pwned\\u\{0007\}mit, failed\): environment, confidence medium$/m,
    );
    expect(text).toContain('gateway-status (environment, medium):');
    expect(text).toContain('run.json /evidence/network/0: 503 GET');
    expect(text).toContain('/api/\\u{001B}[2J\\u{009B}31m');
    expect(controls(io.out.join(''))).toEqual([]);
    expect(controls(text)).toEqual([]);
    expect(text).toMatch(/^Classification file: .+classification\.json$/m);
  });

  it('prints the core Classification with --json, invisible characters escaped, the same object it writes to classification.json', async () => {
    const p = project();
    saveRun(p, 'r_t2', {
      evidence: {
        dir: 'x',
        traces: [],
        console: [],
        network: ['502 GET http://127.0.0.1:9/a\u009b31m\u202eb {}'],
      },
    });
    expect(await reconcile(p, 'r_t2', '--json')).toBe(0);
    expect(controls(io.out.join(''))).toEqual([]);
    expect(io.out.join('')).not.toContain('\u202e');
    const c: Record<string, unknown> = JSON.parse(io.out.join(''));
    expect(Object.keys(c).sort()).toEqual([
      'basis',
      'candidates',
      'class',
      'confidence',
      'hits',
      'notes',
      'runId',
    ]);
    expect(c).toMatchObject({ runId: 'r_t2', class: 'environment' });
    expect(io.out.join('').toLowerCase()).toContain('/a\\u009b31m\\u202eb');
    expect(
      JSON.parse(
        readFileSync(join(p.runs, 'r_t2', 'classification.json'), 'utf8'),
      ),
    ).toEqual(c);
  });

  it.each([
    [['../r_t3']],
    [['r_NOPE']],
    [['r_missing']],
    [[]],
    [['r_t3', '--gaps']],
    [['r_t3', '--out', 'x']],
    [['r_t3', 'r_t4']],
  ])('%j is a usage or config error (exit 2), never 1', async (argv) => {
    const p = project();
    saveRun(p, 'r_t3');
    expect(await reconcile(p, ...argv)).toBe(2);
    expect(io.out.join('')).toBe('');
  });
});

describe('flowctl reconcile --gaps', () => {
  it('exits 2 when there is no app map to read', async () => {
    const p = project();
    expect(await reconcile(p, '--gaps')).toBe(2);
    expect(io.err.join('')).toContain('needs an app map');
  });
});
