import { z } from 'zod';
import { CallSchema, Origin, PageText, Path } from '../schema.js';

/**
 * The free checks, in the order they are reported. Each id is an invariant of the library ADR 0020 names (section c:
 * `no-5xx`, `no-console-error`), so it is also the `ref` of each finding's `sourceRef`.
 *
 * @see docs/adr/0033-read-only-crawl.md (amendment: free checks)
 */
export const CHECK_IDS = [
  'no-console-error',
  'no-4xx',
  'no-5xx',
  'no-broken-link',
  'no-unreachable-page',
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** At most this many findings one check keeps; the rest are counted in `omitted`. */
export const MAX_FINDINGS = 200;

/** A JSON Pointer (RFC 6901) into `appmap.json`: a page, then one of its lists and an index, or its `status`. */
const POINTER =
  /^\/pages\/\d+(\/status|\/(consoleErrors|links)\/\d+|\/calls\/\d+\/status)$/;

/**
 * Where a finding's expectation comes from: the invariant the check is (ADR 0020 section c). The expected value is
 * the rule itself (no 4xx, no console error…); nothing is read from the run.
 */
const SourceRefSchema = z
  .object({ kind: z.literal('invariant'), ref: z.enum(CHECK_IDS) })
  .strict();

/** What a finding stands on: the entry of the crawl's `appmap.json` that was observed, as a JSON Pointer. */
const ObservationRefSchema = z
  .object({
    kind: z.literal('observation'),
    file: z.literal('appmap.json'),
    pointer: z.string().regex(POINTER),
  })
  .strict();

/**
 * One failure of a free check: the page it was seen on, and what was observed there (a document or call `status`,
 * a console `message`, a link `target`), copied from the map, so it carries the map's redaction (ADR 0030).
 */
export const CheckFindingSchema = z
  .object({
    check: z.enum(CHECK_IDS),
    page: Path,
    status: z.number().int().min(0).max(599).optional(),
    call: CallSchema.omit({ status: true }).optional(),
    message: PageText.optional(),
    target: Path.optional(),
    sourceRef: SourceRefSchema,
    observation: ObservationRefSchema,
  })
  .strict()
  .refine((f) => f.sourceRef.ref === f.check, {
    message: 'sourceRef.ref must name the check',
    path: ['sourceRef', 'ref'],
  });

/** One check: `failed` when it has at least one finding. */
export const CheckResultSchema = z
  .object({
    id: z.enum(CHECK_IDS),
    status: z.enum(['passed', 'failed']),
    findings: z.array(CheckFindingSchema).max(MAX_FINDINGS),
    omitted: z.number().int().min(0),
  })
  .strict();

/**
 * The free checks of one crawl (`checks.json`, beside `appmap.json`): a verdict per check, from the map alone (ADR
 * 0004, ADR 0020 section c). `status` is `failed` when any check failed. `truncated` repeats the map's: a pass on a
 * cut map covers only the pages it holds.
 */
export const FreeChecksSchema = z
  .object({
    v: z.literal(1),
    origin: Origin,
    truncated: z.boolean(),
    status: z.enum(['passed', 'failed']),
    checks: z.array(CheckResultSchema).length(CHECK_IDS.length),
  })
  .strict();

export type CheckFinding = z.infer<typeof CheckFindingSchema>;
export type CheckResult = z.infer<typeof CheckResultSchema>;
export type FreeChecks = z.infer<typeof FreeChecksSchema>;
