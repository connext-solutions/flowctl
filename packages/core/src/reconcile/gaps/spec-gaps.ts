import { matchOperations, type MatchReport } from '../../derive/index.js';
import { ConfigError } from '../../foundation/index.js';
import type { AppMap } from '../../observe/index.js';
import type { Operation } from '../../spec/index.js';
import { caveats, gapPage, type MapPage, served } from './pages.js';
import type { CoverageGap } from './schema.js';

/**
 * The match report to read: the given one, or `operations` matched to `map`, or `undefined` without either.
 *
 * @throws {ConfigError} when both `operations` and `report` are given, or the report is of another crawl than `map`.
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
  if (report !== undefined) return report;
  return operations !== undefined && map !== undefined
    ? matchOperations(operations, map)
    : undefined;
}

/** Operations with no screen, then those with tied screens, each kind in report order. */
export function operationGaps(
  report: MatchReport,
  pointers: ReadonlyMap<string, string>,
): CoverageGap[] {
  const cut = caveats(['crawl_truncated', report.truncated]);
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
  const claimed = new Set(
    report.operations.flatMap((m) =>
      m.screen.status === 'matched'
        ? [m.screen.page]
        : m.screen.status === 'ambiguous'
          ? m.screen.pages
          : [],
    ),
  );
  return pages
    .filter((p) => served(p.page) && !claimed.has(p.page.path))
    .map((p) => ({
      kind: 'page_no_spec',
      page: gapPage(p),
      caveats: caveats(['paths_redacted', p.redacted]),
    }));
}
