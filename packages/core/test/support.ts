/**
 * Test-only helpers other packages' tests import as `@flowctl/core-testing` (an alias in
 * `vitest.config.ts` and `tsconfig.tests.json`). It lives under `test/`, so it is never built or published:
 * this is the "test-only module, absent from the build" of ADR 0025 section 1 through which a test reaches
 * the internal `TrustStore.open(dir)` seam.
 */
export {
  consentHooks,
  gitRepo,
  localAnswers,
  testOwnerKey,
  testStore,
} from './trust-fixture.js';
export { exploreConfig, fixtureConfig, seedProfiles, VARS } from './helpers.js';
