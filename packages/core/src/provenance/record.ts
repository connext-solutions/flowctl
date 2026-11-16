import dayjs from 'dayjs';
import { z } from 'zod';
import { NAME_PATTERN } from '../foundation/index.js';
import { SourceRefSchema } from '../flow/index.js';

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/, 'a lowercase hex sha256');
const Name = z.string().regex(NAME_PATTERN);

/** True when `s` is the ISO text of the instant it names: a day 30 of February or an hour 24 does not round-trip. */
const roundTrips = (s: string): boolean => {
  const at = dayjs(s);
  return at.isValid() && at.toISOString() === s;
};

/** The longest signature text read from a record: an Ed25519 signature is 88 base64 characters. */
export const MAX_SIGNATURE_CHARS = 128;

/** One approved assertion: its hash, where it comes from, the polarity the verifier derives operators from, and a number. */
export const ApprovedAssertionSchema = z
  .object({
    hash: Hex64,
    sourceRef: SourceRefSchema.optional(),
    polarity: z.literal('positive'),
    number: z
      .object({
        label: z.string().min(1).max(100),
        unit: z.string().max(32),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ApprovedAssertion = z.infer<typeof ApprovedAssertionSchema>;

/**
 * A case-approval record (ADR 0020 section f): what one reviewer signed for one flow, kept in `<flow>.approvals.json`.
 * `revision` is any number here; the verifier ignores one outside 1..2^53-1 and notes `revision_out_of_range`
 * (Amendment 2026-11-02 section j, rule 1).
 */
export const CaseApprovalRecordSchema = z
  .object({
    v: z.literal(1),
    project: Name,
    flowName: Name,
    flowHash: Hex64,
    revision: z.number(),
    keyId: Hex64,
    approvedAt: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'an ISO time')
      .refine(roundTrips, 'an instant that round-trips through toISOString'),
    assertions: z.array(ApprovedAssertionSchema).max(200),
    replayHashes: z.array(Hex64).min(1).max(8),
    evidenceHash: Hex64,
    baseline: z
      .object({ value: z.string().max(500), evidence: z.string().max(2000) })
      .strict()
      .optional(),
    signature: z.string().max(MAX_SIGNATURE_CHARS),
  })
  .strict();
export type CaseApprovalRecord = z.infer<typeof CaseApprovalRecordSchema>;
