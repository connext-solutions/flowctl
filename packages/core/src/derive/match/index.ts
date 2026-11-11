/**
 * The matcher (task T4.1, ADR 0034): spec operations joined to the pages and controls of an `AppMap`, without a
 * model.
 */
export { matchOperations, WEIGHTS } from './match.js';
export {
  compareText,
  fold,
  normText,
  occurrences,
  quotedSpans,
  refusal,
  type Occurrence,
  type Quoted,
  type Refusal,
  type TextRule,
} from './text.js';
export type {
  MatchEvidence,
  MatchEvidenceKind,
  LiteralMatch,
  MapElement,
  MatchReport,
  OperationMatch,
  RefusedElement,
  ScreenCandidate,
  ScreenVerdict,
  SpecPath,
  SpecSpan,
  UnmatchedStep,
} from './types.js';
