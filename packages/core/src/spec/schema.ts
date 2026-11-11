import { z } from 'zod';
import { NAME_PATTERN } from '../foundation/index.js';

/** A string that is already in Unicode NFC: signed and compared fields are never normalised for the provider. */
const Nfc = z.string().refine((s) => s.normalize('NFC') === s, {
  message: 'must be in Unicode NFC',
});

const NonEmptyNfc = Nfc.refine((s) => s !== '', {
  message: 'must not be empty',
});

/**
 * Where one expected item is in its source: the document, the section heading (or `null`), the inclusive
 * line range (or `null` for a non-file provider) and the provider revision (a git commit or a file hash).
 */
export const SpecRefSchema = z
  .object({
    doc: NonEmptyNfc,
    section: Nfc.nullable(),
    lines: z
      .tuple([z.number().int().min(1), z.number().int().min(1)])
      .refine(([a, b]) => a <= b, {
        message: 'line range must not be reversed',
      })
      .nullable(),
    revision: z.string().min(1),
  })
  .strict();

/** The text around an expected item, part of the signed unit (ADR 0020 amendment, section i.3). */
export const ExpectedContextSchema = z
  .object({
    operationId: NonEmptyNfc,
    operationTitle: Nfc,
    headings: z.array(Nfc),
    leadIn: Nfc.nullable(),
  })
  .strict();

/**
 * One expected result of an operation, with its own `ref` so a `sourceRef` points at exactly one item. `value`
 * is the literal to check (a quoted message, a number as text) or `null` when the item declares none.
 */
export const ExpectedItemSchema = z
  .object({
    text: NonEmptyNfc,
    value: Nfc.nullable().optional(),
    ref: SpecRefSchema,
    context: ExpectedContextSchema,
  })
  .strict();

/**
 * One business operation from a spec source, normalised (ADR 0023). Provider output is untrusted data: it is
 * parsed with this strict schema and never becomes a key, an input name, an `env` reference, a URL, a path or a
 * command (ADR 0023, provider input hardening rule 1).
 *
 * @remarks `location.ref` is the document-level reference (no line range, no revision); `signatureRef` is opaque
 *   to core and only ever handed back to the same provider.
 * @see docs/adr/0023-spec-provider-seam.md
 */
export const OperationSchema = z
  .object({
    id: NonEmptyNfc,
    title: Nfc,
    actor: Nfc.nullable(),
    preconditions: z.array(Nfc),
    steps: z.array(Nfc),
    expected: z.array(ExpectedItemSchema),
    location: z
      .object({
        provider: z.string().regex(NAME_PATTERN, 'must be a flowctl name'),
        ref: NonEmptyNfc,
      })
      .strict(),
    signatureRef: NonEmptyNfc.nullable(),
  })
  .strict();

export type SpecRef = z.infer<typeof SpecRefSchema>;
export type ExpectedItem = z.infer<typeof ExpectedItemSchema>;
export type Operation = z.infer<typeof OperationSchema>;
