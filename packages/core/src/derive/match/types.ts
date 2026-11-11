import type { Refusal, TextRule } from './text.js';

/**
 * Where a string sits in an `Operation`, as property names and indices from the operation down:
 * `['title']`, `['steps', 1]`, `['expected', 0, 'text']`, `['expected', 0, 'context', 'headings', 1]`,
 * `['location', 'ref']`.
 */
export type SpecPath = readonly (string | number)[];

/**
 * A span of spec text: the string at `path`, normalised (`normText`), sliced at the UTF-16 offsets `[start, end)`,
 * equals `text`. Every match cites one, so a reader can check it against the source.
 */
export interface SpecSpan {
  path: SpecPath;
  start: number;
  end: number;
  text: string;
}

/**
 * The `AppMap` element a match points at, by page path (unique in a map, ADR 0033) and index; `name` is the text as
 * the map holds it.
 */
export type MapElement =
  | { kind: 'title'; page: string; name: string }
  | { kind: 'path'; page: string; name: string }
  | { kind: 'control'; page: string; index: number; role: string; name: string }
  | {
      kind: 'field';
      page: string;
      form: number;
      index: number;
      role: string;
      name: string;
    };

/**
 * What one piece of evidence says (ADR 0034):
 * - `title-equal`: the operation title or a heading equals the page title;
 * - `title-mention`: the page title occurs at token boundaries in the operation title, a heading or a step;
 * - `path-literal`: a quoted literal that starts with `/` names the page path (query and fragment dropped);
 * - `doc-segment`: a folder of the operation's `location.ref` equals the first segment of the page path;
 * - `label`: a quoted literal of a step or expected item equals a control or form field name on the page.
 */
export type EvidenceKind =
  | 'title-equal'
  | 'title-mention'
  | 'path-literal'
  | 'doc-segment'
  | 'label';

/** One match: the spec span, the map element, the rule that joined them and the weight it adds to its page. */
export interface Evidence {
  kind: EvidenceKind;
  rule: TextRule;
  weight: number;
  spec: SpecSpan;
  element: MapElement;
}

/** A page that may be the operation's screen: its score (the sum of its distinct evidence) and the evidence. */
export interface ScreenCandidate {
  page: string;
  title: string;
  status: number;
  score: number;
  evidence: Evidence[];
}

/** The screen of an operation: one page with the top score, several tied at the top, or none with any evidence. */
export type ScreenVerdict =
  | { status: 'matched'; page: string }
  | { status: 'ambiguous'; pages: string[] }
  | { status: 'none' };

/**
 * One quoted literal of the operation (normalised) with every span that quotes it and every element it equals,
 * on any page. `kind` is `path` for a literal that starts with `/`. A refused literal has no elements.
 */
export interface LiteralMatch {
  kind: 'label' | 'path';
  text: string;
  spans: SpecSpan[];
  elements: { element: MapElement; rule: TextRule }[];
  refused: Refusal | null;
}

/** A step no evidence cites, or one that quotes a literal found nowhere (`missing`, normalised). */
export interface UnmatchedStep {
  step: number;
  text: string;
  missing: string[];
}

/** What the matcher found for one operation. */
export interface OperationMatch {
  operation: { id: string; title: string; provider: string; ref: string };
  screen: ScreenVerdict;
  screens: ScreenCandidate[];
  literals: LiteralMatch[];
  unmatchedSteps: UnmatchedStep[];
}

/** A map element whose text the Unicode rules refuse: it can match nothing. */
export interface RefusedElement {
  element: MapElement;
  reason: Refusal;
}

/**
 * The matcher's result: one entry per operation, sorted by id, then provider and ref. `truncated` is the map's: a
 * page missing from a truncated map may only be unvisited.
 */
export interface MatchReport {
  v: 1;
  origin: string;
  observedAt: string;
  truncated: boolean;
  operations: OperationMatch[];
  refusedElements: RefusedElement[];
}
