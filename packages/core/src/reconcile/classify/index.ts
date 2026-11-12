/**
 * The failure classifier (task T6.2, ADR 0036): fixed rules that class one failed or errored run as a product bug,
 * spec drift, stale test, environment problem or unknown, with the evidence each rule used.
 *
 * @see docs/adr/0036-failure-classifier.md
 */
export { classifyFailure } from './classify.js';
export { literalPath } from './subject.js';
export {
  type ClassEvidence,
  type Classification,
  CLASSIFY_LIMITS,
  type ClassifyInput,
  type ClassifyLimits,
  type Confidence,
  type FailureClass,
  RULE_IDS,
  type RuleHit,
  type RuleId,
} from './types.js';
