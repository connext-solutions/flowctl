import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ledgerState } from '../src/run/index.js';
import { LedgerFile } from '../src/trust/index.js';
import { refusal, store } from './confirm-fixture.js';

/**
 * The run ledger file in the trust store (ADR 0025 amendment 2026-11-02 section 4, ADR 0024 amendment 2026-11-12
 * section 8): `O_EXCL`, mode 0600, a hash chain from a header line, and the checks of every read.
 */
const RUN = 'r_lq3k2a1b9f0e';

const written = (): { dir: string; path: string } => {
  const s = store();
  const f = LedgerFile.create(s.dir, RUN, null);
  f.append({
    kind: 'intent',
    seq: 1,
    entry: 'items-create',
    name: 'QA-ab12cd34',
  });
  f.append({ kind: 'id', seq: 1, entry: 'items-create', id: '12' });
  f.append({
    kind: 'intent',
    seq: 2,
    entry: 'items-create',
    name: 'QA-ab12cd34-2',
  });
  f.close();
  return { dir: s.dir, path: f.path };
};

describe('LedgerFile', () => {
  it('writes a header and chained lines with mode 0600, and reads them back', () => {
    const { dir, path } = written();
    expect(execFileSync('stat', ['-f', '%Lp', path]).toString().trim()).toBe(
      '600',
    );
    const { file, lines } = LedgerFile.open(dir, RUN, null);
    file.close();
    expect(lines.map((l) => l.kind)).toEqual([
      'ledger-header',
      'intent',
      'id',
      'intent',
    ]);
    expect(lines[0]).toMatchObject({
      v: 1,
      runId: RUN,
      bundleId: null,
      prev: '0'.repeat(64),
    });
  });

  it('refuses a second ledger for the same run id: ledger_exists', () => {
    const { dir } = written();
    expect(refusal(() => LedgerFile.create(dir, RUN, null))).toMatch(
      /^ledger_exists/,
    );
  });

  it('finds a changed byte (chain), another bundle (foreign), a link or a FIFO (not_regular, without blocking)', () => {
    const { dir, path } = written();
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.replace('"id":"12"', '"id":"13"'));
    expect(refusal(() => LedgerFile.open(dir, RUN, null))).toContain('Line 3');
    writeFileSync(path, text);
    expect(refusal(() => LedgerFile.open(dir, RUN, 'bundle-2'))).toContain(
      'another bundle',
    );
    rmSync(path);
    symlinkSync('/etc/hosts', path);
    expect(refusal(() => LedgerFile.open(dir, RUN, null))).toContain(
      'regular file',
    );
    rmSync(path);
    execFileSync('mkfifo', [path]);
    expect(refusal(() => LedgerFile.open(dir, RUN, null))).toContain(
      'regular file',
    );
  });

  it('refuses a ledgers directory with mode 0755', () => {
    const { dir } = written();
    chmodSync(join(dir, 'ledgers'), 0o755);
    expect(refusal(() => LedgerFile.create(dir, 'r_other1', null))).toContain(
      '0700',
    );
  });
});

describe('ledgerState', () => {
  it('leaves an intent without an answer unconfirmed, a 409 not, and skips ids already confirmed', () => {
    const { dir } = written();
    const { file, lines } = LedgerFile.open(dir, RUN, null);
    expect(ledgerState(lines)).toEqual({
      targets: [
        { entry: 'items-create', id: '12', seq: 1, name: 'QA-ab12cd34' },
      ],
      unconfirmed: [{ entry: 'items-create', name: 'QA-ab12cd34-2' }],
    });
    file.append({ kind: 'none', seq: 2, status: 409 });
    file.append({
      kind: 'cleanup',
      seq: 1,
      entry: 'items-create',
      id: '12',
      result: 'confirmed',
    });
    file.close();
    const again = LedgerFile.open(dir, RUN, null);
    again.file.close();
    expect(ledgerState(again.lines)).toEqual({ targets: [], unconfirmed: [] });
  });
});
