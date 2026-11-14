/**
 * The vocabulary of the contract readers (T4.10, ADR 0040): the facts they read from a contracts root, what they
 * leave out, the caps that bound every read, and the consistency checks built from fact pairs.
 *
 * @see docs/adr/0040-contract-readers.md
 */

/** The formats a fact is read from. */
export type ContractSource = 'openapi' | 'zod' | 'joi' | 'html' | 'i18n';

/**
 * Which end of a request the source describes: a form or a client-side schema (`client`), an API contract or a
 * server-side validator (`server`), a message catalogue (`catalogue`). The defaults are in {@link DEFAULT_SIDES}.
 */
export type ContractSide = 'client' | 'server' | 'catalogue';

/**
 * What a fact states: a constraint (`required`, `minLength`, `maxLength`, `min`, `max`, `pattern`, `enum`), a
 * declared `type`, a `status` code of a response, a `schema` link (a name a request or response, or an `allOf`
 * member, points at), or a catalogue `message`.
 */
export type ContractRule =
  | 'required'
  | 'minLength'
  | 'maxLength'
  | 'min'
  | 'max'
  | 'pattern'
  | 'enum'
  | 'type'
  | 'status'
  | 'schema'
  | 'message';

/**
 * One thing a contract file states, read from the text and never paraphrased: `value` is the literal (numbers in
 * one canonical form, an enum as a JSON array of its sorted values), `pointer` addresses it inside `file`, `line`
 * is 1-based.
 *
 * @remarks Every string except `value` is bounded and free of invisible characters, so `pointer` can become part of
 *   a reference. `value`, `field` and `messageKey` are untrusted text: data to compare, never a name, a path or an
 *   instruction (ADR 0023 rule 1).
 */
export interface ContractFact {
  source: ContractSource;
  side: ContractSide;
  file: string;
  line: number;
  pointer: string;
  owner: string;
  field: string;
  rule: ContractRule;
  value: string;
  messageKey?: string;
}

/** A file, or a construct in it, the readers did not read, and why; `line` is 0 for a whole file. */
export interface SkippedContract {
  file: string;
  line: number;
  reason: string;
}

/** What {@link readContracts} returns: facts and skips in a fixed order, and what was read. */
export interface ContractReport {
  facts: readonly ContractFact[];
  skipped: readonly SkippedContract[];
  files: number;
  bytes: number;
}

/** The bounds of one read; a bound that is passed refuses the file, or the whole read for the totals. */
export interface ContractLimits {
  maxEntries: number;
  maxFiles: number;
  maxFileBytes: number;
  maxBytes: number;
  maxFacts: number;
  maxNodes: number;
  maxDepth: number;
  maxRefs: number;
  maxTokens: number;
  maxTags: number;
  maxAttributes: number;
  maxString: number;
}

/** The default bounds. */
export const CONTRACT_LIMITS: ContractLimits = {
  maxEntries: 20_000,
  maxFiles: 2_000,
  maxFileBytes: 1024 * 1024,
  maxBytes: 32 * 1024 * 1024,
  maxFacts: 100_000,
  maxNodes: 200_000,
  maxDepth: 64,
  maxRefs: 2_000,
  maxTokens: 400_000,
  maxTags: 20_000,
  maxAttributes: 64,
  maxString: 4_000,
};

/** The side each source describes unless the caller says otherwise. */
export const DEFAULT_SIDES: Readonly<Record<ContractSource, ContractSide>> = {
  openapi: 'server',
  joi: 'server',
  zod: 'client',
  html: 'client',
  i18n: 'catalogue',
};

/** Options of {@link readContracts}. */
export interface ContractOptions {
  /** The name the refs carry in front of the path; `contracts` when a root has none. */
  rootName?: string;
  limits?: Partial<ContractLimits>;
  sides?: Partial<Record<ContractSource, ContractSide>>;
}

/** What a comparison of two sides found: values agree, differ, one side lacks the rule, or it cannot be judged. */
export type CheckOutcome = 'equal' | 'differs' | 'missing' | 'unknown';

/** The three consistency checks of ADR 0020 section 3 rule 3. */
export type CheckKind = 'client_server' | 'message_i18n' | 'response_schema';

/**
 * One consistency check: the facts compared and what was found, never a verdict, a flow or an assertion.
 * `reason` is a fixed code (`values_agree`, `absent_on_server`, `key_missing`, ...), never text from a contract.
 */
export interface ConsistencyCheck {
  kind: CheckKind;
  field: string;
  rule: ContractRule;
  outcome: CheckOutcome;
  reason: string;
  facts: readonly ContractFact[];
  locale?: string;
}
