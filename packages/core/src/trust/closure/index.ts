/**
 * The hook closure of ADR 0021 (Amendment 2026-11-01 section 2, refined by Amendment 2026-11-02): an
 * allowlist judge of `setup`/`teardown` text and the scripts it runs, and the hook consent digest. The one
 * closure function the hook, confirm and classify digests share.
 *
 * @see docs/adr/0021-hook-consent.md
 */
export { type HookDigestInput, hookConsentDigest } from './digest.js';
export { hashFlowFile, readVerifiedFile } from './files.js';
export type {
  Closure,
  ClosureFile,
  Uncovered,
  UncoveredReason,
} from './types.js';
export { type ClosureOptions, computeClosure } from './walk.js';
