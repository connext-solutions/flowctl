import { z } from 'zod';

/**
 * The kinds of coverage gap, in the order they are reported (ADR 0037):
 * - `route_unvisited`: a route of the code index that no crawled page path matches;
 * - `page_no_route`: a crawled page that no code route declares (a catch-all alone does not count);
 * - `operation_no_ui`: a spec operation the match report gives no screen (`none`);
 * - `operation_ambiguous`: a spec operation with several screens tied at the top score;
 * - `page_no_spec`: a crawled page that no operation's screen verdict names.
 *
 * @see docs/adr/0037-coverage-gaps.md
 */
export const GAP_KINDS = [
  'route_unvisited',
  'page_no_route',
  'operation_no_ui',
  'operation_ambiguous',
  'page_no_spec',
] as const;

export type GapKind = (typeof GAP_KINDS)[number];

/**
 * Why a gap may not be real:
 * - `crawl_truncated`: the crawl stopped at a cap, so the page or screen may only be past the budget;
 * - `paths_redacted`: a page path holds the redaction mask `***`, which can hide the segment a route or a quoted
 *   address names.
 */
export const GAP_CAVEATS = ['crawl_truncated', 'paths_redacted'] as const;

export type GapCaveat = (typeof GAP_CAVEATS)[number];

/** A JSON Pointer to one page of `appmap.json`: `/pages/3`. */
const PagePointer = z.string().regex(/^\/pages\/(?:0|[1-9]\d*)$/);

/** A route as the code index holds it: full pattern, declared pattern, extractor, file and 1-based line. */
export const GapRouteSchema = z
  .object({
    path: z.string(),
    pattern: z.string(),
    source: z.string(),
    file: z.string(),
    line: z.number().int().min(1),
  })
  .strict();

/** A crawled page as the map holds it (path and title already redacted), with its pointer into `appmap.json`. */
export const GapPageSchema = z
  .object({
    path: z.string(),
    title: z.string(),
    status: z.number().int().min(0).max(599),
    pointer: PagePointer,
  })
  .strict();

/** A spec operation as the match report names it, with its index in `report.operations`. */
export const GapOperationSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    provider: z.string(),
    ref: z.string(),
    index: z.number().int().min(0),
  })
  .strict();

const Caveats = z.array(z.enum(GAP_CAVEATS));

/** One coverage gap with its evidence and caveats. */
export const CoverageGapSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('route_unvisited'),
      route: GapRouteSchema,
      caveats: Caveats,
    })
    .strict(),
  z
    .object({
      kind: z.literal('page_no_route'),
      page: GapPageSchema,
      caveats: Caveats,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation_no_ui'),
      operation: GapOperationSchema,
      caveats: Caveats,
    })
    .strict(),
  z
    .object({
      kind: z.literal('operation_ambiguous'),
      operation: GapOperationSchema,
      pages: z.array(
        z
          .object({ path: z.string(), pointer: PagePointer.nullable() })
          .strict(),
      ),
      caveats: Caveats,
    })
    .strict(),
  z
    .object({
      kind: z.literal('page_no_spec'),
      page: GapPageSchema,
      caveats: Caveats,
    })
    .strict(),
]);

/**
 * What `coverageGaps` found: the crawl it read (`origin`, `observedAt` and `truncated` of the map or report, `null`
 * without either), how many page paths hold the mask, the kinds its inputs let it check, and the gaps, by kind in
 * {@link GAP_KINDS} order. A kind missing from `checked` was not looked at, which is not the same as no gap.
 */
export const CoverageGapsSchema = z
  .object({
    v: z.literal(1),
    origin: z.string().nullable(),
    observedAt: z.string().nullable(),
    truncated: z.boolean(),
    redactedPages: z.number().int().min(0),
    checked: z.array(z.enum(GAP_KINDS)),
    gaps: z.array(CoverageGapSchema),
  })
  .strict();

export type GapRoute = z.infer<typeof GapRouteSchema>;
export type GapPage = z.infer<typeof GapPageSchema>;
export type GapOperation = z.infer<typeof GapOperationSchema>;
export type CoverageGap = z.infer<typeof CoverageGapSchema>;
export type CoverageGaps = z.infer<typeof CoverageGapsSchema>;
