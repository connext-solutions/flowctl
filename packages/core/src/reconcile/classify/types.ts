import type { AppMap } from '../../observe/index.js';
import type { RunResult } from '../../result.js';
import type { Operation, SpecRef } from '../../spec/index.js';
import type { CodeIndex } from '../code/index.js';

/**
 * What a failure most likely is (ADR 0036): a defect of the app, a spec that the code no longer follows, a test whose
 * label or route moved, an infrastructure problem, or not known.
 */
export type FailureClass =
  | 'product_bug'
  | 'spec_drift'
  | 'stale_test'
  | 'environment'
  | 'unknown';

/** How strongly a rule's evidence points at its class; `high` > `medium` > `low`. */
export type Confidence = 'high' | 'medium' | 'low';

/** The rules, in the fixed order the classifier runs them (ADR 0036 decision 3). */
export const RULE_IDS = [
  'error-kind',
  'gateway-status',
  'no-response',
  'server-error',
  'foreign-server-error',
  'label-spec-drift',
  'label-stale',
  'label-product-bug',
  'route-spec-drift',
  'route-stale',
  'route-product-bug',
] as const;

export type RuleId = (typeof RULE_IDS)[number];

/**
 * One fact a rule stands on, with where to check it: a JSON Pointer into `run.json`, a file and line of the code
 * index, a JSON Pointer into `appmap.json`, or a JSON Pointer into the spec `Operation` with its `SpecRef` (`null`
 * for a step, whose document is `doc`). `text` is the untrusted string as found, cut to {@link CLASSIFY_LIMITS}.
 */
export type ClassEvidence =
  | { source: 'run'; pointer: string; text: string }
  | {
      source: 'code';
      record: 'label' | 'message' | 'route';
      file: string;
      line: number;
      text: string;
    }
  | { source: 'map'; pointer: string; text: string }
  | {
      source: 'spec';
      operation: string;
      doc: string;
      pointer: string;
      ref: SpecRef | null;
      text: string;
    };

/** A rule that fired: its class, confidence, the evidence it used and a fixed sentence saying why. */
export interface RuleHit {
  rule: RuleId;
  class: Exclude<FailureClass, 'unknown'>;
  confidence: Confidence;
  why: string;
  evidence: ClassEvidence[];
}

/**
 * The classifier's answer for one run: advice for a person, never a verdict (ADR 0004, ADR 0036).
 *
 * @remarks `class` is `unknown` with `confidence: null` when no rule fired or when rules of different classes tie at
 *   the top confidence; a tie lists those hits in `candidates` and picks none. `basis` holds the hits of the chosen
 *   class at its confidence; `hits` holds every rule that fired, in rule order. `notes` are fixed sentences about
 *   inputs the rules could not use (a refused text, a pattern that is not a literal path).
 */
export interface Classification {
  runId: string;
  class: FailureClass;
  confidence: Confidence | null;
  basis: RuleHit[];
  candidates: RuleHit[];
  hits: RuleHit[];
  notes: string[];
}

/**
 * One failed or errored run and what is known around it. Only `result` is required; each optional input enables the
 * rules that read it. `origins` are the app's own origins (default: `map.origin` when a map is given).
 */
export interface ClassifyInput {
  result: RunResult;
  code?: CodeIndex;
  map?: AppMap;
  spec?: Operation;
  origins?: readonly string[];
}

/** Bounds on untrusted text: what a rule compares, what a near search scans, what evidence carries. */
export interface ClassifyLimits {
  /** Code points of a failing text or locator name; a longer one is not compared. */
  maxSubject: number;
  /** Code points of a code or page string a near search reads; longer ones are not compared. */
  maxCompared: number;
  /** Code points of `text` in one evidence entry; longer text is cut and ends with `…`. */
  maxEvidenceText: number;
  /**
   * Code points the `contains` near search may read in total (each compared string's plus the failing text's);
   * past it the search stops with a note.
   */
  maxComparedPoints: number;
  /** Distinct near texts kept per failure. */
  maxNear: number;
  /** Evidence entries of one source kind for one text (the failing text, or one near text), or failed calls of one rule. */
  maxEvidencePerSource: number;
}

/**
 * The default bounds: subject 300, compared 1,000, evidence text 200 code points, a near search budget of 5,000,000
 * code points, 5 near texts, 5 entries per source. Frozen.
 */
export const CLASSIFY_LIMITS: Readonly<ClassifyLimits> = Object.freeze({
  maxSubject: 300,
  maxCompared: 1000,
  maxEvidenceText: 200,
  maxComparedPoints: 5_000_000,
  maxNear: 5,
  maxEvidencePerSource: 5,
});
