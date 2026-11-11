import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ledgerState } from '../src/run/index.js';
import { LedgerFile, TrustError } from '../src/trust/index.js';
import { LEDGER_IO } from '../src/trust/ledger-file.js';
import { refusal, store } from './confirm-fixture.js';

/** The `detail` of the `ledgers_invalid` refusal `f` throws, or what it threw otherwise. */
const detailOf = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return e instanceof TrustError && e.kind === 'ledgers_invalid'
      ? String(e.detail)
      : String(e);
  }
  return 'accepted';
};

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

  it('refuses an append after close with a typed error', () => {
    const s = store();
    const f = LedgerFile.create(s.dir, RUN, null);
    f.close();
    expect(
      refusal(() => f.append({ kind: 'none', seq: 1, status: 409 })),
    ).toMatch(/^ledgers_invalid: .*closed/);
  });

  it('reads every line before a torn last line, reports it, and appends after it', () => {
    const { dir, path } = written();
    appendFileSync(path, '{"kind":"id","seq":2,"entry":"items-cre');
    const { file, lines, torn } = LedgerFile.open(dir, RUN, null);
    expect(torn).toBe(true);
    expect(lines.map((l) => l.kind)).toEqual([
      'ledger-header',
      'intent',
      'id',
      'intent',
    ]);
    file.append({ kind: 'none', seq: 2, status: 409 });
    file.close();
    const again = LedgerFile.open(dir, RUN, null);
    again.file.close();
    expect(again.torn).toBe(false);
    expect(again.lines.at(-1)?.kind).toBe('none');
  });

  it('keeps a complete last line that lost only its newline, and a broken line before the last stays chain', () => {
    const { dir, path } = written();
    const text = readFileSync(path, 'utf8');
    writeFileSync(path, text.slice(0, -1));
    const { file, lines, torn } = LedgerFile.open(dir, RUN, null);
    expect(torn).toBe(false);
    expect(lines).toHaveLength(4);
    file.append({ kind: 'none', seq: 2, status: 409 });
    file.close();
    const again = LedgerFile.open(dir, RUN, null);
    again.file.close();
    expect(again.lines.at(-1)?.kind).toBe('none');
    const parts = readFileSync(path, 'utf8').split('\n');
    parts[2] = parts[2]?.slice(0, 10) ?? '';
    writeFileSync(path, parts.join('\n'));
    expect(refusal(() => LedgerFile.open(dir, RUN, null))).toContain('Line 2');
  });

  it.each(['write', 'fsync'] as const)(
    'cuts a failed %s back to the last good line and refuses every later append write_failed',
    (which) => {
      const s = store();
      const f = LedgerFile.create(s.dir, RUN, null);
      f.append({ kind: 'intent', seq: 1, entry: 'items-create', name: 'QA-a' });
      const good = readFileSync(f.path, 'utf8');
      const real = { ...LEDGER_IO };
      const enospc = Object.assign(new Error('ENOSPC: no space left'), {
        code: 'ENOSPC',
      });
      if (which === 'write')
        LEDGER_IO.write = (fd, buf, off, len) => {
          real.write(fd, buf, off, Math.min(len, 7));
          throw enospc;
        };
      else
        LEDGER_IO.fsync = () => {
          throw enospc;
        };
      try {
        expect(
          detailOf(() =>
            f.append({ kind: 'id', seq: 1, entry: 'items-create', id: '12' }),
          ),
        ).toBe('write_failed');
      } finally {
        Object.assign(LEDGER_IO, real);
      }
      expect(readFileSync(f.path, 'utf8')).toBe(good);
      expect(
        detailOf(() => f.append({ kind: 'none', seq: 1, status: 409 })),
      ).toBe('write_failed');
      f.close();
      const again = LedgerFile.open(s.dir, RUN, null);
      again.file.close();
      expect(again.torn).toBe(false);
      expect(again.lines.map((l) => l.kind)).toEqual([
        'ledger-header',
        'intent',
      ]);
    },
  );

  it('holds a lock with its pid from create to close: open meanwhile is busy, and two opens at once', () => {
    const s = store();
    const f = LedgerFile.create(s.dir, RUN, null);
    const lock = join(s.dir, 'ledgers', `${RUN}.lock`);
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    expect(execFileSync('stat', ['-f', '%Lp', lock]).toString().trim()).toBe(
      '600',
    );
    expect(detailOf(() => LedgerFile.open(s.dir, RUN, null))).toBe('busy');
    f.close();
    expect(existsSync(lock)).toBe(false);
    const first = LedgerFile.open(s.dir, RUN, null);
    expect(detailOf(() => LedgerFile.open(s.dir, RUN, null))).toBe('busy');
    first.file.close();
    LedgerFile.open(s.dir, RUN, null).file.close();
  });

  it('takes over a stale lock whose pid is gone, and says so', () => {
    const { dir } = written();
    const lock = join(dir, 'ledgers', `${RUN}.lock`);
    const gone = spawnSync('true').pid;
    writeFileSync(lock, `${gone}\n`, { mode: 0o600 });
    const { file, staleLock } = LedgerFile.open(dir, RUN, null);
    expect(staleLock).toBe(true);
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    file.close();
    expect(existsSync(lock)).toBe(false);
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
