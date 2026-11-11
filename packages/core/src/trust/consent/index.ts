/**
 * Hook consent kept in the trust store (ADR 0025 section 5, ADR 0021 Amendment 2026-11-01 section 1 and
 * Amendment 2026-11-02 sections 9 and 10): owner-signed entries per (project, flow), the run-time check, and
 * the env allowlist. The command that writes entries (`flowctl trust hook`) and the run that uses them come
 * in later chunks.
 *
 * @see docs/adr/0021-hook-consent.md
 */
export {
  checkHookConsent,
  createHookConsent,
  type HookConsent,
  hookEntryId,
  type HookRefusal,
  type HookRequest,
} from './entry.js';
export {
  checkHookEnv,
  type HookEnvProblem,
  isPinnedName,
  localeAllowed,
  pgpassShapeOk,
} from './env.js';
