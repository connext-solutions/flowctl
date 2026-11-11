import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { type Closure, readVerifiedFile } from '../closure/index.js';
import { SCRATCH } from '../closure/paths.js';

/**
 * A hook snapshot (ADR 0021 Amendment 2026-11-01 section 2.7, Amendment 2026-11-02 section 2): a fresh
 * 0700 directory under `/tmp` holding `root/` (the cwd, a mirror of the closure files only, each 0500, with
 * the empty 0700 scratch directory `.hook-tmp/`), `home/` (`HOME`) and `tmp/` (`TMPDIR`).
 */
export interface HookSnapshot {
  dir: string;
  cwd: string;
  home: string;
  tmp: string;
  closure: Closure;
}

/** Why a snapshot cannot be made or used: details of `hook_env_unsafe`. */
export type SnapshotProblem = 'snapshot_unavailable' | 'snapshot_modified';

/**
 * Copies every closure file into a fresh snapshot, from bytes re-read and matched to their sha256, and checks
 * that a script can be executed there (a `noexec` `/tmp` is `snapshot_unavailable`).
 *
 * @param root the flows root the closure was computed against.
 * @returns the snapshot, or the problem; a hook never runs unsnapshotted.
 */
export function createHookSnapshot(
  root: string,
  closure: Closure,
): HookSnapshot | SnapshotProblem {
  let dir: string;
  try {
    dir = realpathSync(mkdtempSync('/tmp/flowctl-hook-'));
  } catch {
    return 'snapshot_unavailable';
  }
  try {
    chmodSync(dir, 0o700);
    const snap: HookSnapshot = {
      dir,
      cwd: join(dir, 'root'),
      home: join(dir, 'home'),
      tmp: join(dir, 'tmp'),
      closure,
    };
    for (const d of [snap.cwd, snap.home, snap.tmp, join(snap.cwd, SCRATCH)])
      mkdirSync(d, { recursive: true, mode: 0o700 });
    const sealed = new Set<string>();
    for (const f of closure.files) {
      const bytes = readVerifiedFile(root, f.path, f.sha256);
      if (bytes === undefined) throw new Error('closure file changed');
      const target = join(snap.cwd, f.path);
      mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, bytes, { flag: 'wx', mode: 0o500 });
      chmodSync(target, 0o500);
      sealed.add(dirname(target));
    }
    if (!canExecute(dir)) throw new Error('noexec');
    for (const d of sealed) chmodSync(d, 0o500);
    return snap;
  } catch {
    removeHookSnapshot(dir);
    return 'snapshot_unavailable';
  }
}

/**
 * Re-reads every closure file from the snapshot and compares it with its sha256 immediately before a hook
 * starts, so a change made by `setup` or by another process stops `teardown` (`snapshot_modified`).
 */
export function verifyHookSnapshot(
  snap: HookSnapshot,
): SnapshotProblem | undefined {
  for (const f of snap.closure.files)
    if (readVerifiedFile(snap.cwd, f.path, f.sha256) === undefined)
      return 'snapshot_modified';
  return undefined;
}

/**
 * Deletes a snapshot: every directory is made writable again (checked with `lstat`, so a symlink is never
 * followed), then the tree is removed without following links.
 *
 * @remarks Node has no `unlinkat`, so this walks paths rather than descriptors as ADR 0021 section 2.7
 *   describes; `lstat` before each `chmod` and `rmSync` (which never follows a symlink) keep a planted link
 *   from redirecting the cleanup. It never throws.
 */
export function removeHookSnapshot(dir: string): void {
  const open = (d: string): void => {
    let st;
    try {
      st = lstatSync(d);
    } catch {
      return;
    }
    if (!st.isDirectory()) return;
    try {
      chmodSync(d, 0o700);
      for (const name of readdirSync(d)) open(join(d, name));
    } catch {
      return;
    }
  };
  open(dir);
  rmSync(dir, { recursive: true, force: true });
}

function canExecute(dir: string): boolean {
  const probe = join(dir, 'probe');
  writeFileSync(probe, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const r = spawnSync(probe, [], { stdio: 'ignore', env: {}, timeout: 5000 });
  rmSync(probe, { force: true });
  return r.status === 0;
}
