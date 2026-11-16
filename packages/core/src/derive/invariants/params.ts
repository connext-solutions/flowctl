import { z } from 'zod';
import { NAME_PATTERN } from '../../foundation/index.js';
import { LocSchema } from '../../flow/index.js';
import { ControlSchema, Path } from '../../observe/index.js';
import {
  DRIVE_VALUE_PREFIX,
  InvariantEvidenceSchema,
  type Evidence,
} from './evidence.js';
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
  const text = Object.hasOwn(inputs, name) ? inputs[name] : undefined;
  if (text === undefined)
    return refuse('bad_input', 'the input is not a value input of the flow');
  if (!text.startsWith(DRIVE_VALUE_PREFIX) || !text.includes('{{uid}}'))
    return refuse('bad_input', 'the input is not a QA- value made by {{uid}}');
  return text;
}

const UID = '{{uid}}';

/** What `{{uid}}` may stand for in a value a drive wrote: the 1 to 8 lowercase hex digits of a run's uid. */
const UID_SHAPE = '[0-9a-f]{1,8}';

/**
 * Whether `sent` is a value the input template `template` writes: the template's text taken literally, each `{{uid}}`
 * one bounded run of uid characters ({@link UID_SHAPE}). A template holding any other `{{` never matches, so a
 * value that only looks like the input's is never bound to it.
 */
export function writes(template: string, sent: string | undefined): boolean {
  if (sent === undefined) return false;
  const parts = template.split(UID);
  if (parts.some((part) => part.includes('{{'))) return false;
  const literal = parts.map((part) =>
    part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
  );
  return new RegExp(`^${literal.join(UID_SHAPE)}$`, 'u').test(sent);
}

/** Where a `within` locator sits on a page of the map: one of its named regions, one of its controls, or nowhere. */
export function withinOn(
  evidence: Evidence,
  page: string,
  within: { role?: string; name?: string; testId?: string },
): 'region' | 'control' | undefined {
  const p = evidence.map.pages.find((x) => x.path === page);
  if (p === undefined || within.testId !== undefined) return undefined;
  if (within.role === undefined || within.name === undefined) return undefined;
  const is = (c: { role: string; name: string }) =>
    c.role === within.role && c.name === within.name;
  if ((p.regions ?? []).some(is)) return 'region';
  return p.controls.some(is) ? 'control' : undefined;
}

/** A binding over `steps`, or the refusal that there are none. */
export const bound = (steps: number[], what: string): Binding | Refusal =>
  steps.length === 0
    ? refuse('no_evidence', `the drive recorded no ${what}`)
    : { ok: true, steps };
