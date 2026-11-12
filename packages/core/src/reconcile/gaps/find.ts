import type { MatchReport } from '../../derive/index.js';
import type { AppMap } from '../../observe/index.js';
import type { Operation } from '../../spec/index.js';
import {
  type CodeIndex,
  matchRoute,
  parseRoutePattern,
  type RouteRecord,
  type RouteSegment,
} from '../code/index.js';
import {
  byCode,
  caveats,
  gapPage,
  type MapPage,
  mapPages,
  served,
} from './pages.js';
import type { CoverageGap, CoverageGaps, GapKind } from './schema.js';
import { operationGaps, reportOf, unclaimedPages } from './spec-gaps.js';

/** What `coverageGaps` reads; each kind of gap is checked only when its inputs are given. */
export interface CoverageInputs {
  /** The code index of the app's source (T6.1). */
  index?: CodeIndex;
  /** The `AppMap` of one crawl (ADR 0033). */
  map?: AppMap;
  /** Spec operations, matched to `map` here when no `report` is given. */
  operations?: readonly Operation[];
  /** A match report of the same crawl as `map` (ADR 0034). */
  report?: MatchReport;
}

/** A route of the index with its parsed pattern. */
interface ParsedRoute {
  record: RouteRecord;
  pattern: RouteSegment[];
}

const matches = (r: ParsedRoute, p: MapPage): boolean =>
  p.segments !== undefined && matchRoute(r.pattern, p.segments);

/** Routes no page matches, by path, file, line and extractor. */
function unvisitedRoutes(
  routes: readonly ParsedRoute[],
  pages: readonly MapPage[],
  truncated: boolean,
  redacted: boolean,
): CoverageGap[] {
  return routes
    .filter((r) => !pages.some((p) => matches(r, p)))
    .map((r) => r.record)
    .sort(
      (a, b) =>
        byCode(a.path, b.path) ||
        byCode(a.file, b.file) ||
        a.line - b.line ||
        byCode(a.source, b.source),
    )
    .map(({ path, pattern, source, file, line }) => ({
      kind: 'route_unvisited',
      route: { path, pattern, source, file, line },
      caveats: caveats(
        ['crawl_truncated', truncated],
        ['paths_redacted', redacted],
      ),
    }));
}

/** Served pages with a comparable path that no route matches, a route made only of rest segments aside. */
function undeclaredPages(
  routes: readonly ParsedRoute[],
  pages: readonly MapPage[],
): CoverageGap[] {
  const declaring = routes.filter((r) =>
    r.pattern.some((s) => s.kind !== 'rest'),
  );
  return pages
    .filter((p) => served(p.page) && p.segments !== undefined)
    .filter((p) => !declaring.some((r) => matches(r, p)))
    .map((p) => ({
      kind: 'page_no_route',
      page: gapPage(p),
      caveats: caveats(['paths_redacted', p.redacted]),
    }));
}

/**
 * The coverage gaps between an app's code, one crawl of it and its spec (task T6.4): routes no crawled page
 * matches, crawled pages no route declares, operations with no screen or tied screens, and pages no operation
 * claims. Pure, no model, no I/O.
 *
 * @remarks A kind is checked only when its inputs are given (`checked`): code with a map for the route kinds, a
 *   report (or operations and a map) for the operation kinds, both for `page_no_spec`. Page paths are compared as
 *   the map holds them, redacted, through the code index's own path rules (`routeQuerySegments`, `matchRoute`). A
 *   gap the crawl's page budget may explain carries `crawl_truncated`; one a mask may explain, `paths_redacted`.
 *   Gaps are ordered by kind (`GAP_KINDS`), routes by path, file, line and extractor, pages by path in UTF-16
 *   code units, operations in report order.
 * @throws {ConfigError} when both `operations` and `report` are given, or the report is of another crawl than `map`.
 * @see docs/adr/0037-coverage-gaps.md
 */
export function coverageGaps(input: CoverageInputs): CoverageGaps {
  const { index, map } = input;
  const report = reportOf(input);
  const crawl = map ?? report;
  const truncated = crawl?.truncated ?? false;
  const pages = mapPages(map);
  const redactedPages = pages.filter((p) => p.redacted).length;
  const checked: GapKind[] = [];
  const gaps: CoverageGap[] = [];
  if (index !== undefined && map !== undefined) {
    const routes = index.routes.map((record) => ({
      record,
      pattern: parseRoutePattern(record.path),
    }));
    checked.push('route_unvisited', 'page_no_route');
    gaps.push(
      ...unvisitedRoutes(routes, pages, truncated, redactedPages > 0),
      ...undeclaredPages(routes, pages),
    );
  }
  if (report !== undefined) {
    const pointers = new Map(pages.map((p) => [p.page.path, p.pointer]));
    checked.push('operation_no_ui', 'operation_ambiguous');
    gaps.push(...operationGaps(report, pointers));
    if (map !== undefined) {
      checked.push('page_no_spec');
      gaps.push(...unclaimedPages(report, pages));
    }
  }
  return {
    v: 1,
    origin: crawl?.origin ?? null,
    observedAt: crawl?.observedAt ?? null,
    truncated,
    redactedPages,
    checked,
    gaps,
  };
}
