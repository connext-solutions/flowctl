/**
 * Test-only helpers other packages' tests import as `@flowctl/core-testing` (an alias in
 * `vitest.config.ts` and `tsconfig.tests.json`). It lives under `test/`, so it is never built or published:
 * this is the "test-only module, absent from the build" of ADR 0025 section 1 through which a test reaches
 * the internal `TrustStore.open(dir)` seam.
 */
export {
  allowEnvVars,
  consentHooks,
  gitRepo,
  localAnswers,
  reopenStore,
  testOwnerKey,
  testStore,
} from './trust-fixture.js';
export { exploreConfig, fixtureConfig, seedProfiles, VARS } from './helpers.js';
export { SECRET_ENV, echoFlow, withSecret } from './redaction/echo-flow.js';
export { findSecret, freshSecret } from './redaction/find-secret.js';
export { leaksIn, runOutputs } from './redaction/scan.js';
