import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { computeClosure, TrustError } from '../src/trust/index.js';

/**
 * C3 of T1.0: the bypasses found in review, the remaining cases of ADR 0021 Amendment 2026-11-02 section 12,
 * and a differential test of the quote table against the real shells.
 */
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'flowctl-edge-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const first = (setup: string): string =>
  computeClosure({ root, setup }).uncovered[0]?.reason ?? 'pass';

describe('bypasses found in review', () => {
  it('refuses an assignment word in command position, even one that names a script', () => {
    mkdirSync(join(root, 'A=.'));
    writeFileSync(join(root, 'A=.', 'x'), 'true\n', { mode: 0o755 });
    expect(first("A=./x python3 -c 'print(1)'")).toBe('command_not_allowed');
    expect(first('A+=./x true')).toBe('command_not_allowed');
  });

  it('never reads a closure file from the scratch directory in another letter case', () => {
    mkdirSync(join(root, '.HOOK-TMP'));
    writeFileSync(join(root, '.HOOK-TMP', 'x.sh'), 'true\n', { mode: 0o755 });
    expect(first('./.HOOK-TMP/x.sh')).toBe('missing_file');
    expect(first('cat ./.Hook-Tmp/x.sh')).toBe('missing_file');
    const c = computeClosure({ root, setup: '[ -f ./.HOOK-TMP/x.sh ]' });
    expect(c.uncovered).toEqual([]);
    expect(c.files).toEqual([]);
  });

  it('refuses a shell metacharacter right after a non-ASCII character', () => {
    expect(first("true 中\\' '\npython3 -c x\ntrue '")).toBe('syntax');
    expect(first('true "中\\""')).toBe('syntax');
    expect(first('rm -f ./.hook-tmp/Á|cat ./victim')).toBe('syntax');
    expect(first('true 中 \\x')).toBe('pass');
    expect(first("true '中|'")).toBe('pass');
  });

  it('judges psql options named like Object prototype keys without throwing', () => {
    expect(first("psql -X constructor x -c 'select 1'")).toBe('psql_input');
    expect(first("psql -X __proto__ x -c 'select 1'")).toBe('psql_input');
  });
});

describe('remaining section 12 cases', () => {
  it('refuses a test of a symlink', () => {
    writeFileSync(join(root, 'real'), 'x');
    symlinkSync(join(root, 'real'), join(root, 'link'));
    expect(first('[ -f ./link ]')).toBe('symlink');
  });

  it('refuses a path word with a newline, or not in NFC', () => {
    expect(first("touch './.hook-tmp/a\nb'")).toBe('operand_shape');
    expect(first('touch ./.hook-tmp/e\u0301')).toBe('operand_shape');
  });

  it('refuses the 51st file and more than 1 MiB in total', () => {
    const names = Array.from({ length: 51 }, (_, k) => `f${k}.sh`);
    for (const n of names) writeFileSync(join(root, n), 'true\n');
    expect(first(`cat ${names.map((n) => `./${n}`).join(' ')}`)).toBe(
      'limit_exceeded',
    );
    const big = Array.from({ length: 5 }, (_, k) => `b${k}.sh`);
    for (const n of big)
      writeFileSync(join(root, n), `#${'x'.repeat(250 * 1024)}\n`);
    expect(first(`cat ${big.map((n) => `./${n}`).join(' ')}`)).toBe(
      'limit_exceeded',
    );
  });

  it('marks a closure unbound exactly when a command is uncovered', () => {
    expect(computeClosure({ root, setup: 'true' }).unbound).toBe(false);
    expect(computeClosure({ root, setup: 'python3 -c x' }).unbound).toBe(true);
  });

  it('reports a flows root that cannot be resolved as a TrustError', () => {
    expect(() =>
      computeClosure({ root: join(root, 'absent'), setup: 'true' }),
    ).toThrow(TrustError);
  });
});

/** Section 1 says these words are literal: neither shell may expand them, in a directory where a glob matches. */
const LITERAL: [string, string][] = [
  ["'~'", '~'],
  ['"~"', '~'],
  ['\\~', '~'],
  ['a~b', 'a~b'],
  ['a/~', 'a/~'],
  ["'*'", '*'],
  ['"*"', '*'],
  ['\\*', '*'],
  ['"{a,b}"', '{a,b}'],
  ["'$HOME'", '$HOME'],
  ['"\\$HOME"', '$HOME'],
  ['"a:~"', 'a:~'],
  ['a}', 'a}'],
];

describe.each(['/bin/sh', '/bin/dash'].filter((s) => existsSync(s)))(
  'quote table against %s',
  (shell) => {
    it.each(LITERAL)('keeps %s literal', (word, text) => {
      writeFileSync(join(root, 'a'), '');
      writeFileSync(join(root, 'b'), '');
      expect(first(`true ${word}`)).toBe('pass');
      const out = spawnSync(shell, ['-c', `printf '%s\\n' ${word}`], {
        cwd: root,
        env: { PATH: '/usr/bin:/bin', HOME: '/home/flowctl-probe' },
        encoding: 'utf8',
      });
      expect(out.stdout).toBe(`${text}\n`);
    });
  },
);
