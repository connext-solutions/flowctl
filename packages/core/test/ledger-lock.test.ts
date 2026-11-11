import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TrustError } from '../src/trust/index.js';
import { LedgerLock, LOCK_IO } from '../src/trust/ledger-lock.js';

const RUN = 'r_lq3k2a1b9f0e';

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

/** A ledgers directory holding a lock left by a process that is gone. */
function staleDir(): { dir: string; lock: string } {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-lock-'));
  const lock = join(dir, `${RUN}.lock`);
  writeFileSync(lock, `${spawnSync('true').pid}\n`, { mode: 0o600 });
  return { dir, lock };
}

/**
 * Runs `take` with the lock reads stubbed: before read number `at` returns, `during` runs once (another process
 * acting in between, in this one).
 */
function interleaved<T>(at: number, during: () => void, take: () => T): T {
  const real = LOCK_IO.read;
  let reads = 0;
  LOCK_IO.read = (fd, buf) => {
    const n = real(fd, buf);
    reads++;
    if (reads === at) {
      LOCK_IO.read = real;
      during();
    }
    return n;
  };
  try {
    return take();
  } finally {
    LOCK_IO.read = real;
  }
}

/** Two takeovers of the same stale lock (ADR 0024 amendment 2026-11-12 section 8): only one may remove it. */
describe('LedgerLock takeover', () => {
  it('never removes a fresh lock another process took over after this one judged the old one stale', () => {
    const { dir, lock } = staleDir();
    let other: LedgerLock | undefined;
    const detail = interleaved(
      1,
      () => {
        const taken = LedgerLock.take(dir, RUN);
        expect(taken.stale).toBe(true);
        other = taken.lock;
      },
      () => detailOf(() => LedgerLock.take(dir, RUN)),
    );
    expect(detail).toBe('busy');
    expect(readFileSync(lock, 'utf8').trim()).toBe(String(process.pid));
    other?.release();
    expect(existsSync(lock)).toBe(false);
  });

  it('refuses busy while another takeover of the same lock is in progress, and the first one finishes', () => {
    const { dir, lock } = staleDir();
    let second = '';
    const first = interleaved(
      2,
      () => {
        expect(existsSync(`${lock}.takeover`)).toBe(true);
        second = detailOf(() => LedgerLock.take(dir, RUN));
      },
      () => LedgerLock.take(dir, RUN),
    );
    expect(second).toBe('busy');
    expect(first.stale).toBe(true);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
    first.lock.release();
  });

  it('removes a takeover file left by a crash once it is older than its bound', () => {
    const { dir, lock } = staleDir();
    writeFileSync(`${lock}.takeover`, '', { mode: 0o600 });
    expect(detailOf(() => LedgerLock.take(dir, RUN))).toBe('busy');
    const old = new Date(Date.now() - 60_000);
    utimesSync(`${lock}.takeover`, old, old);
    const { lock: taken, stale } = LedgerLock.take(dir, RUN);
    expect(stale).toBe(true);
    expect(existsSync(`${lock}.takeover`)).toBe(false);
    taken.release();
  });
});
