import { z } from 'zod';
import { INVISIBLE_CLASS } from '../../foundation/index.js';
import {
  AppMapSchema,
  CallSchema,
  ControlSchema,
  Path,
} from '../../observe/index.js';

const HIDDEN = new RegExp(`[${INVISIBLE_CLASS}]`, 'u');

/** Text read from a page: at most 300 characters and no invisible or control code point (ADR 0020 section d). */
const Seen = z
  .string()
  .max(300)
  .refine((s) => !HIDDEN.test(s), 'no control or invisible characters');

/** The prefix every value a drive writes carries, so test data is recognisable and removable (ADR 0020 section c). */
export const DRIVE_VALUE_PREFIX = 'QA-';

/**
 * What the page showed at one moment of a step: whether the step's value was among its text (`listed`) and the text of
 * the row's state control or status (`state`, `null` when the page has none).
 */
export const PageStateSchema = z
  .object({ listed: z.boolean(), state: Seen.nullable() })
  .strict();

/** What a step does: create, edit or delete a record, move it to its next state, or probe a rule with a bad value. */
export const DRIVE_ACTIONS = [
  'create',
  'edit',
  'delete',
  'transition',
  'probe',
] as const;

/**
 * One action a drive took on a page and what it saw (the evidence ADR 0041 section 3 fixes for the round-trip
 * invariants). `request` is the call the click sent, `null` when it sent none; `clientBlocked` is true when the page
 * refused to send. `sent` is the value written (always `QA-` prefixed); `readBack` is the value read from the page after
 * a reload, `null` when the step reads none. `toast` is the text of the status region once the action settled.
 *
 * @remarks T2.8 (the drive stage) must emit this shape, or this schema moves to `observe/` and is imported from there.
 *   No field value is read from a page the drive did not write itself, and no expected value is taken from a run.
 */
export const DriveStepSchema = z
  .object({
    action: z.enum(DRIVE_ACTIONS),
    page: Path,
    control: ControlSchema,
    field: ControlSchema.optional(),
    sent: Seen.optional(),
    request: CallSchema.omit({ origin: true }).nullable(),
    clientBlocked: z.boolean(),
    before: PageStateSchema,
    after: PageStateSchema,
    reloaded: PageStateSchema.nullable(),
    readBack: Seen.nullable(),
    toast: Seen.nullable(),
  })
  .strict()
  .refine(
    (s) => s.sent === undefined || s.sent.startsWith(DRIVE_VALUE_PREFIX),
    {
      message: `a drive writes only values starting with ${DRIVE_VALUE_PREFIX}`,
      path: ['sent'],
    },
  );

/** The drive of one app: its steps in order (`drive.json`). */
export const DriveRecordSchema = z
  .object({ v: z.literal(1), steps: z.array(DriveStepSchema).max(200) })
  .strict();
export type DriveStep = z.infer<typeof DriveStepSchema>;
export type DriveRecord = z.infer<typeof DriveRecordSchema>;

/**
 * Everything an invariant reads: the crawl's map, the drive record when one ran, and the `{ value }` inputs of the
 * flow being derived, by name, with their template text (for example `QA-{{uid}}`). `env` inputs are never listed.
 */
export const InvariantEvidenceSchema = z
  .object({
    map: AppMapSchema,
    drive: DriveRecordSchema.optional(),
    inputs: z.record(z.string(), z.string().max(300)).default({}),
  })
  .strict();
export type InvariantEvidence = z.input<typeof InvariantEvidenceSchema>;
export type Evidence = z.infer<typeof InvariantEvidenceSchema>;

/** A JSON Pointer into `drive.json` a finding may stand on: one field of one step. */
export const DRIVE_POINTER =
  /^\/steps\/\d+(\/after|\/reloaded|\/readBack|\/toast|\/request\/status)$/;
