import { lstatSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { isAbsolute } from 'node:path';
import { type HookConsent, localeAllowed } from '../consent/index.js';
import { assertNotInRepository } from '../location.js';
import type { HookSnapshot } from './snapshot.js';

/** The store-side fixed `PATH` of ADR 0021 Amendment 2026-11-01 section 2.9 (the default list). */
export const HOOK_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** Why the hook environment cannot be built: details of `hook_env_unsafe`. */
export type EnvProblem =
  | { detail: 'path_unsafe'; name: string }
  | { detail: 'env_value_mismatch'; name: string };

const TZ = /^[A-Za-z0-9_+-]{1,32}$/;
const TERM = /^[A-Za-z0-9_.-]+$/;

/**
 * Builds a hook's environment from nothing (ADR 0021 Amendment 2026-11-01 section 2.9, Amendment 2026-11-02
 * sections 9 and 10): the fixed `PATH`, `HOME` and `TMPDIR` inside the snapshot, `USER` and `LOGNAME` from
 * the passwd entry, `LANG`/`LC_*` only for English or Vietnamese UTF-8 or C, `TZ` and `TERM` by pattern, the
 * consented pass-through names, and each pinned name only if the parent value equals the pin byte for byte.
 *
 * @param parent the caller's environment; only the names above are read from it.
 * @returns the environment, or the problem; a mismatch names the variable, never a value.
 */
export function buildHookEnv(
  snap: HookSnapshot,
  entry: HookConsent,
  parent: Readonly<Record<string, string | undefined>>,
): { ok: true; env: Record<string, string> } | ({ ok: false } & EnvProblem) {
  for (const dir of HOOK_PATH)
    if (!pathDirSafe(dir))
      return { ok: false, detail: 'path_unsafe', name: dir };
  const me = userInfo();
  const env: Record<string, string> = {
    PATH: HOOK_PATH.join(':'),
    HOME: snap.home,
    TMPDIR: snap.tmp,
    USER: me.username,
    LOGNAME: me.username,
  };
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if ((name === 'LANG' || name.startsWith('LC_')) && localeAllowed(value))
      env[name] = value;
    if (name === 'TZ' && TZ.test(value)) env[name] = value;
    if (name === 'TERM' && TERM.test(value)) env[name] = value;
  }
  for (const name of entry.env) {
    const value = parent[name];
    const pin = Object.hasOwn(entry.pins, name) ? entry.pins[name] : undefined;
    if (pin !== undefined) {
      if (value !== pin)
        return { ok: false, detail: 'env_value_mismatch', name };
      env[name] = value;
    } else if (value !== undefined) env[name] = value;
  }
  return { ok: true, env };
}

/**
 * A `PATH` entry: absolute, resolving to a real directory owned by root or the current user, writable by no
 * one else and outside every repository. A missing entry passes (it adds nothing to the lookup).
 */
function pathDirSafe(dir: string): boolean {
  if (!isAbsolute(dir)) return false;
  let real: string;
  try {
    real = realpathSync(dir);
  } catch {
    return true;
  }
  const st = lstatSync(real);
  if (!st.isDirectory()) return false;
  if (st.uid !== 0 && st.uid !== userInfo().uid) return false;
  if ((st.mode & 0o022) !== 0) return false;
  try {
    assertNotInRepository(real);
  } catch {
    return false;
  }
  return true;
}
