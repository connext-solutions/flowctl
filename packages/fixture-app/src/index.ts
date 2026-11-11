import { fileURLToPath } from 'node:url';

export {
  BUG_MODES,
  startFixture,
  type BugMode,
  type Fixture,
} from './server.js';
export { CRAWL_BUG_MODES, DECOYS, type CrawlBugMode } from './crawl.js';
export { MESSAGES } from './pages.js';
export {
  LEAVE_REQUEST_RULES,
  type RuleFailure,
  validateLeaveRequest,
} from './validator.js';

/** Absolute path of the contract artefacts (`openapi.yaml`, `i18n/vi.json`) the contract readers parse (T2.9). */
export const FIXTURE_CONTRACTS_DIR = fileURLToPath(
  new URL('../contracts', import.meta.url),
);

/** Absolute path of the sample flows (leave-approve, leave-validation, leave-submit, leave-persist) written for this app. */
export const FIXTURE_FLOWS_DIR = fileURLToPath(
  new URL('../flows', import.meta.url),
);
export {
  FAKE_TARGET_WAITS,
  startFakeSystem1,
  type FakeMove,
  type FakeSystem1,
} from './system1.js';
