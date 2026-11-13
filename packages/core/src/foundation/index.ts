/**
 * The lowest layer of core: shared names, typed errors and symlink-safe filesystem helpers, with no
 * dependency on any other core folder. Everything here is re-exported at the old paths (`config.ts`,
 * `result.ts`, `flow/`, `run/`, `browser/`, `safe-fs.ts`) so existing imports keep working (task T1.0).
 */
export {
  NAME_PATTERN,
  ConfigError,
  MAX_STEPS_CAP,
  maskSecrets,
  TRUST_SUBCOMMANDS,
} from './names.js';
export {
  assertNever,
  type ErrorKind,
  FlowError,
  RunError,
  type StepErrorKind,
  StepError,
} from './errors.js';
export {
  assertNotSymlink,
  ensureDirInside,
  NoFollowReadError,
  readFileNoFollow,
  writeFileNoFollow,
} from './safe-fs.js';
export { isPrivateHost } from './hosts.js';
export {
  FIXTURES_DIR,
  MAX_UPLOAD_BYTES,
  readFixture,
  type FixtureFile,
} from './fixtures.js';
export { PROVENANCE_STATES, type ProvenanceStateName } from './provenance.js';
