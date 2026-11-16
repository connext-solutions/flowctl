import type { z } from 'zod';
import type { Assertion } from '../../flow/index.js';
import type { Path } from '../../observe/index.js';

/**
 * The ten invariants, in the order the library lists them (ADR 0020 section c, ADR 0041). Each id is also the `ref`
 * of the `sourceRef` an expansion carries; `no-5xx` and `no-console-error` are the ids of the free checks.
 */
export const INVARIANT_IDS = [
  'crud-create-appears',
  'crud-edit-shows',
  'crud-delete-absent',
  'reload-keeps-data',
  'no-5xx',
  'no-console-error',
  'round-trip-equality',
  'state-change-after-action',
  'success-toast-implies-2xx',
  'client-blocks-what-server-rejects',
] as const;
export type InvariantId = (typeof INVARIANT_IDS)[number];

/** Why a template cannot bind: the evidence has nothing it needs, an input is unusable or the parameters are wrong. */
export type RefusalReason = 'bad_params' | 'no_evidence' | 'bad_input';

/** A refusal: a reason and a fixed sentence. Never page text, so a hostile page cannot write into it. */
export interface Refusal {
  ok: false;
  reason: RefusalReason;
  detail: string;
}

/** Where a binding found its evidence: indexes into the drive record, never values. */
export interface Binding {
  ok: true;
  steps: number[];
}

/** An expansion: the assertion, with its `sourceRef` `{ kind: 'invariant', ref }` and nothing else. */
export type Expansion =
  | { ok: true; assertion: Assertion }
  | { ok: false; reason: 'not_expandable'; detail: string };

/** A JSON Pointer into `appmap.json` or `drive.json`. */
export interface Observation {
  kind: 'observation';
  file: 'appmap.json' | 'drive.json';
  pointer: string;
}

/** One failure an invariant found, the page it was on and the evidence entry it stands on. */
export interface InvariantFinding {
  invariant: InvariantId;
  page: z.infer<typeof Path>;
  status?: number;
  message?: string;
  sourceRef: { kind: 'invariant'; ref: InvariantId };
  observation: Observation;
}

/** The verdict of one invariant on one body of evidence: a refusal, or its findings (none is a pass). */
export type Evaluation = Refusal | { ok: true; findings: InvariantFinding[] };

/**
 * One invariant template (ADR 0041). `params` is a strict schema whose fields are template-defined enums, paths,
 * controls or `valueFrom` input names, never free text. `bind` ties the parameters to evidence, `evaluate` judges
 * what was observed and `expand` writes the flow assertion, or says it is `not_expandable` while the assertion schema
 * cannot say it. All three take raw parameters and refuse what the schema does not accept.
 */
export interface InvariantTemplate {
  id: InvariantId;
  params: z.ZodType<object>;
  bind(evidence: unknown, params: unknown): Binding | Refusal;
  evaluate(evidence: unknown, params: unknown): Evaluation;
  expand(evidence: unknown, params: unknown): Expansion | Refusal;
}
