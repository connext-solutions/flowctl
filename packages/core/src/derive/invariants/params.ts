import { z } from 'zod';
import { NAME_PATTERN } from '../../foundation/index.js';
import { LocSchema } from '../../flow/index.js';
import { ControlSchema, Path } from '../../observe/index.js';
import { DRIVE_VALUE_PREFIX, InvariantEvidenceSchema } from './evidence.js';
import type { Binding, InvariantId, Refusal, RefusalReason } from './types.js';

/** The name of a `{ value }` input of the flow: a flow name, so nothing read from a page can become one. */
export const InputName = z.string().regex(NAME_PATTERN);

/** Parameters of the invariants that name a page and a value input. */
export const ValueParams = z
  .object({ page: Path, valueFrom: InputName, within: LocSchema.optional() })
  .strict();

/** Parameters of the invariants that name a page and the control a drive acted on. */
export const ControlParams = z
  .object({ page: Path, control: ControlSchema })
  .strict();

/** Parameters of the invariants that name a page and one of its fields. */
export const FieldParams = z
  .object({ page: Path, field: ControlSchema })
  .strict();

/** Parameters of the round-trip invariant: a page, a field and the input that holds the value written. */
export const RoundTripParams = FieldParams.extend({ valueFrom: InputName });

/** The parameters of the two free checks: none. */
export const NoParams = z.object({}).strict();

/** A refusal with a fixed sentence. */
export const refuse = (reason: RefusalReason, detail: string): Refusal => ({
  ok: false,
  reason,
  detail,
});

/** The sourceRef every expansion carries: the invariant and nothing else. */
export const invariantRef = (
  id: InvariantId,
): { kind: 'invariant'; ref: InvariantId } => ({ kind: 'invariant', ref: id });

/** Evidence as the schema reads it, or the refusal that it is malformed. */
export function readEvidence(
  evidence: unknown,
): z.infer<typeof InvariantEvidenceSchema> | Refusal {
  const parsed = InvariantEvidenceSchema.safeParse(evidence);
  return parsed.success
    ? parsed.data
    : refuse('bad_input', 'the evidence is not valid');
}

/**
 * The template text of input `name`, when the flow has it as a `{ value }` input that writes a `QA-` value made unique
 * by `{{uid}}`; a refusal otherwise.
 */
export function valueInput(
  inputs: Record<string, string>,
  name: string,
): string | Refusal {
  const text = inputs[name];
  if (text === undefined)
    return refuse('bad_input', 'the input is not a value input of the flow');
  if (!text.startsWith(DRIVE_VALUE_PREFIX) || !text.includes('{{uid}}'))
    return refuse('bad_input', 'the input is not a QA- value made by {{uid}}');
  return text;
}

/** A binding over `steps`, or the refusal that there are none. */
export const bound = (steps: number[], what: string): Binding | Refusal =>
  steps.length === 0
    ? refuse('no_evidence', `the drive recorded no ${what}`)
    : { ok: true, steps };
