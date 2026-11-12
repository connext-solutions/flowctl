/**
 * Coverage gaps (task T6.4, ADR 0037): what the code declares, a crawl saw and the spec describes, and where the
 * three do not meet, with the evidence of each gap.
 *
 * @see docs/adr/0037-coverage-gaps.md
 */
export { coverageGaps, type CoverageInputs } from './find.js';
export {
  CoverageGapSchema,
  CoverageGapsSchema,
  GAP_CAVEATS,
  GAP_KINDS,
  type CoverageGap,
  type CoverageGaps,
  type GapCaveat,
  type GapKind,
  type GapOperation,
  type GapPage,
  type GapRoute,
} from './schema.js';
export { gapsJson, gapsMarkdown, writeGaps } from './write.js';
