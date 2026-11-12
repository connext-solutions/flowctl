import {
  matchOperations,
  type MatchReport,
  type ScreenVerdict,
} from '../../derive/index.js';
import { ConfigError } from '../../foundation/index.js';
import type { AppMap } from '../../observe/index.js';
import type { Operation } from '../../spec/index.js';
import { caveats, gapPage, type MapPage, served } from './pages.js';
import type { CoverageGap } from './schema.js';

/**
 * The match report to read: the given one, or `operations` matched to `map`, or `undefined` without either.
 *
 * @throws {ConfigError} when both `operations` and `report` are given, or, with `map`, the report is of another
 *   crawl (origin or time), has another `truncated`, or names a screen or tied page the map does not hold.
 */
export function reportOf(input: {
  map?: AppMap;
  operations?: readonly Operation[];
  report?: MatchReport;
}): MatchReport | undefined {
  const { map, operations, report } = input;
  if (operations !== undefined && report !== undefined)
    throw new ConfigError(
      'coverageGaps takes operations or a match report, not both: pass the report alone.',
    );
  if (
    report !== undefined &&
    map !== undefined &&
    (report.origin !== map.origin || report.observedAt !== map.observedAt)
  )
    throw new ConfigError(
      'the match report is of another crawl than the app map: match the operations against this map again.',
    );
  if (report !== undefined && map !== undefined) {
    if (report.truncated !== map.truncated)
      throw new ConfigError(
        `the match report says truncated: ${report.truncated}, the app map ${map.truncated}: match the operations against this map again.`,
      );
    const held = new Set(map.pages.map((p) => p.path));
    const missing = report.operations
      .flatMap((m) => named(m.screen))
      .find((path) => !held.has(path));
    if (missing !== undefined)
      throw new ConfigError(
        `the match report names a page the app map does not hold (${JSON.stringify(missing)}): match the operations against this map again.`,
      );
  }
  if (report !== undefined) return report;
  return operations !== undefined && map !== undefined
    ? matchOperations(operations, map)
    : undefined;
}

/** The page paths a screen verdict names: its screen, the tied pages, or none. */
const named = (screen: ScreenVerdict): string[] =>
  screen.status === 'matched'
    ? [screen.page]
    : screen.status === 'ambiguous'
      ? screen.pages
      : [];

/**
 * Operations with no screen, then those with tied screens, each kind in report order.
 *
 * @param redacted whether any page path of the map holds the mask, which can hide the path literal or doc segment
 *   the matcher scores a screen by; unknown, so `false`, from a report alone.
 */
export function operationGaps(
  report: MatchReport,
  pointers: ReadonlyMap<string, string>,
  redacted: boolean,
): CoverageGap[] {
  const cut = caveats(
    ['crawl_truncated', report.truncated],
    ['paths_redacted', redacted],
  );
  const ops = report.operations.map((m, index) => ({
    m,
    operation: { ...m.operation, index },
  }));
  const none: CoverageGap[] = ops
    .filter(({ m }) => m.screen.status === 'none')
    .map(({ operation }) => ({
      kind: 'operation_no_ui',
      operation,
      caveats: [...cut],
    }));
  const tied: CoverageGap[] = ops.flatMap(({ m, operation }) =>
    m.screen.status === 'ambiguous'
      ? [
          {
            kind: 'operation_ambiguous' as const,
            operation,
            pages: m.screen.pages.map((path) => ({
              path,
              pointer: pointers.get(path) ?? null,
            })),
            caveats: [...cut],
          },
        ]
      : [],
  );
  return [...none, ...tied];
}

/** Served pages that no operation's verdict names, as its screen or as one of a tie. */
export function unclaimedPages(
  report: MatchReport,
  pages: readonly MapPage[],
): CoverageGap[] {
  const claimed = new Set(report.operations.flatMap((m) => named(m.screen)));
  return pages
    .filter((p) => served(p.page) && !claimed.has(p.page.path))
    .map((p) => ({
      kind: 'page_no_spec',
      page: gapPage(p),
      caveats: caveats(['paths_redacted', p.redacted]),
    }));
}
