import { z } from 'zod';
import { NAME_PATTERN } from '../../foundation/index.js';

/**
 * The shape of one `destructiveConfirm` entry value (ADR 0024 section 5, "The `destructiveConfirm` entry (schema)",
 * and its amendment 2026-11-12 "destructive ledger details"): strict objects, one per `kind`, so an unknown field or
 * a field of another kind makes the entry invalid. The rules between fields and between entries are in `rules.ts`.
 *
 * @remarks `queryKeys` defaults to `[]` and `prefix` to `QA-`, as the ADR says; the owner signature covers the
 *   stored value before those defaults are applied, so a default never changes what was signed.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
const Name = z.string().regex(NAME_PATTERN);

const Common = {
  id: Name,
  env: Name,
  origin: z.string(),
  expires: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/),
  flow: Name,
  hash: z.string().regex(/^[0-9a-f]{64}$/),
  template: z.string(),
  contentType: z.enum(['json', 'urlencoded']).optional(),
  bodyKeys: z.array(z.string()),
  queryKeys: z.array(z.string()).default([]),
  headers: z.array(z.string()).optional(),
};

const Cleanup = z
  .object({
    method: z.literal('DELETE'),
    template: z.string(),
    verify: z.object({ template: z.string() }).strict(),
  })
  .strict();

const CreateEntry = z
  .object({
    ...Common,
    kind: z.literal('create'),
    method: z.literal('POST'),
    idFrom: z.string(),
    nameField: z.string(),
    prefix: z.string().default('QA-'),
    naturalKeys: z.array(z.string()).min(1),
    conflictStatus: z
      .array(z.union([z.literal(409), z.literal(422)]))
      .min(1)
      .max(2),
    cleanup: Cleanup,
  })
  .strict();

const MutateEntry = z
  .object({
    ...Common,
    kind: z.literal('mutate'),
    method: z.enum(['PATCH', 'PUT', 'DELETE']),
    ledgerFrom: Name,
    idPositions: z.array(z.string()).min(1),
  })
  .strict();

const SessionEntry = z
  .object({
    ...Common,
    kind: z.literal('session'),
    method: z.literal('POST'),
  })
  .strict();

/** One entry value, parsed. */
export const ConfirmEntrySchema = z.discriminatedUnion('kind', [
  CreateEntry,
  MutateEntry,
  SessionEntry,
]);
export type ConfirmEntry = z.infer<typeof ConfirmEntrySchema>;
export type CreateConfirm = z.infer<typeof CreateEntry>;
export type MutateConfirm = z.infer<typeof MutateEntry>;

/** How an entry is kept in the store: its value and the owner signature over that value as stored. */
export const StoredConfirmSchema = z
  .object({ value: z.unknown(), sig: z.string() })
  .strict();

/** The signed-entry kind of a destructive confirmation (ADR 0025 Amendment 2026-11-02 section 5). */
export const CONFIRM_KIND = 'destructiveConfirm';
