/**
 * Running consented hooks (ADR 0021 Amendment 2026-11-01 sections 2.7 and 2.9, Amendment 2026-11-02 sections
 * 9 and 10): one snapshot per run, the environment built from nothing, `/bin/sh -c` in its own process group.
 *
 * @see docs/adr/0021-hook-consent.md
 */
export { buildHookEnv, HOOK_PATH } from './env.js';
export { type HookTarget, HookSession } from './runner.js';
export {
  createHookSnapshot,
  type HookSnapshot,
  removeHookSnapshot,
  verifyHookSnapshot,
} from './snapshot.js';
export { type HookOutput, spawnHook } from './spawn.js';
