/**
 * The trust store (ADR 0025): a per-machine, owner-controlled store of every value that grants power;
 * repository files can only narrow what it allows, and a missing entry means refuse. Done so far: read +
 * validate, the owner key with signed entries, the hook closure, consent and snapshot, `trust init` with the
 * owner's env classes, `trust add env`, the profile env-var allowlist with `trust add profile` (T1.14), the
 * command registry with its guard, `trust.log` with the anchor, the other `trust add` kinds, and owner-key
 * rotation, and `trust init --replace`. Still to come: the CI layouts.
 *
 * `TrustStore.open(dir)` is a test-only seam; it is re-exported here for the trust folder's own tests
 * but must not be surfaced from `packages/core/src/index.ts` (ADR 0025 section 1).
 *
 * @see docs/adr/0025-trust-store.md
 */
export {
  buildHookEnv,
  createHookSnapshot,
  type HookOutput,
  type HookSnapshot,
  type HookTarget,
  HookSession,
  removeHookSnapshot,
  spawnHook,
  verifyHookSnapshot,
} from './hookrun/index.js';
export { createStoreDoc, replaceStoreDoc } from './write.js';
export {
  planReplace,
  planRotation,
  rotateOwner,
  rotateOwnerUntil,
  type RotationPlan,
  type RotationStep,
} from './rotate.js';
export { recoverRotation, type Recovery } from './rotate-recover.js';
export {
  type Replaced,
  type ReplaceInit,
  replaceStore,
  replaceStoreUntil,
  type ReplaceStep,
} from './replace.js';
export { abandonReplace, stagedStoreDir } from './replace-abandon.js';
export { type EntryCounts } from './rotate-sign.js';
export { identityMatches, projectIdentity } from './identity.js';
export { addProject, planProject, type ProjectPlan } from './projects.js';
export {
  addProductionOrigin,
  checkProductionOrigin,
  checkProjectSetting,
  setProjectSetting,
  type ProjectSetting,
} from './settings.js';
export {
  ENV_VAR_NAME,
  addProfileEnvVar,
  allowedEnvVar,
  trustedProfile,
  type EnvVarEntry,
  type EnvVarKind,
  type TrustedProfile,
} from './env-vars.js';
export { addEnvOrigin, checkEnvOrigin, type OriginSet } from './env-origins.js';
export {
  addSystem1,
  hostPortOf,
  planSystem1,
  type System1Addition,
  type TrustedSystem1,
  trustedSystem1,
} from './system1.js';
export {
  type FlowsRoot,
  flowsRootFor,
  projectFor,
  type TrustedProject,
  trustedProject,
} from './registry.js';
export {
  assertCanWrite,
  assertNoStore,
  displayText,
  type HookPlan,
  openTrustStore,
  planHookConsent,
  saveHookConsents,
} from './admin.js';
export {
  assertEnvsConsistent,
  type InitAnswers,
  initTrust,
  isOrigin,
  LANGUAGE_PATTERN,
  LOCALE_PATTERN,
  type TrustedEnvAnswer,
  validateInit,
} from './init.js';
export {
  addTrustedEnv,
  hostOf,
  isLoopback,
  isProductionOrigin,
  productionHosts,
  productionOriginFor,
  type TrustedEnv,
  trustedEnv,
} from './envs.js';
export {
  type CommandName,
  COMMANDS,
  isCommand,
  type McpCommand,
  MCP_TOOLS,
  requireStore,
  requireTrust,
  type Trusted,
} from './commands.js';
export { TrustError, type TrustErrorKind } from './errors.js';
export { canonicalJson } from './canonical.js';
export {
  type Closure,
  type ClosureFile,
  type ClosureOptions,
  computeClosure,
  type HookDigestInput,
  hookConsentDigest,
  type Uncovered,
  type UncoveredReason,
} from './closure/index.js';
export {
  checkHookConsent,
  checkHookEnv,
  createHookConsent,
  type HookConsent,
  hookEntryId,
  type HookEnvProblem,
  type HookRefusal,
  type HookRequest,
  isPinnedName,
  localeAllowed,
  pgpassShapeOk,
} from './consent/index.js';
export {
  assertNotInRepository,
  defaultKeyDir,
  defaultStoreDir,
} from './location.js';
export { createOwnerKey, loadOwnerKey, type OwnerKey } from './owner-key.js';
export {
  entryBytes,
  fingerprintOf,
  type SignedEntry,
  verifyEntry,
} from './signing.js';
export {
  ENV_CLASSES,
  type EnvClass,
  type TrustStoreDoc,
  TrustStoreSchema,
} from './schema.js';
export { TrustStore } from './store.js';
export {
  confirmLine,
  type ConfirmDigestInput,
  type ConfirmEntry,
  ConfirmEntrySchema,
  type ConfirmPlan,
  type ConfirmRead,
  type CreateConfirm,
  latestExpiry,
  literalPrefix,
  MAX_DAYS,
  type MutateConfirm,
  parseIdPosition,
  parsePointer,
  parseTemplate,
  planConfirm,
  readConfirmEntries,
  type ReadContext,
  revokeConfirmEntry,
  saveConfirmEntries,
  type Segment,
  type IdPosition,
  utcDate,
  canonicalId,
  type ConfirmFile,
  confirmFiles,
  type Draft,
  type EntryBase,
  entryOf,
  proposeDrafts,
  type RecordedCall,
  type RecordedWrite,
  recordedWrites,
  renewConfirmEntries,
  storedConfirmEntries,
  escapeSegment,
  idValues,
  type Leaf,
  leavesOf,
  matchEntry,
  type Matched,
  MAX_BULK,
  parseStrictJson,
  readBody,
  stringAt,
  type WireRequest,
} from './confirm/index.js';
export {
  LedgerFile,
  type LedgerLine,
  type NewLedgerLine,
  RUN_ID_PATTERN,
} from './ledger-file.js';
