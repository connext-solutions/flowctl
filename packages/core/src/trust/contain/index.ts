/**
 * The shared containment helper (ADR 0023 rule 3, ADR 0024 section 1a): every spec provider and contract reader
 * reads files below a root only through these functions. Today the caller opens the root by path
 * ({@link openRoot}); the trust-store `roots` reader will return the same {@link ContainedRoot} for a verified
 * entry of the reader's purpose (ADR 0025 section 2).
 *
 * @see docs/adr/0023-spec-provider-seam.md
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export {
  checkRoot,
  componentProblem,
  type ContainedRoot,
  ContainmentError,
  type ContainmentErrorKind,
  MAX_DEPTH,
  openRoot,
  requirePurpose,
  type RootPurpose,
  splitRelative,
} from './root.js';
export { readContained } from './read.js';
export {
  ByteBudget,
  type SkippedEntry,
  WALK_LIMITS,
  type WalkedFile,
  type WalkLimits,
  type WalkOptions,
  walkContained,
} from './walk.js';
