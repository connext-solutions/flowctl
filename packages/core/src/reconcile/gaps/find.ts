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

/** A pattern made only of rest segments (`*`, `/:slug*`): the app's "not found" page. The root `/` is not one. */
const catchAll = (p: readonly RouteSegment[]): boolean =>
  p.length > 0 && p.every((s) => s.kind === 'rest');

/**
 * Pages with a comparable path by segment count, and, built on first use, by the segment at one position: the
 * candidates a pattern needs, so a route is not tested against every page.
 */
class PageBuckets {
  private readonly byLength = new Map<number, MapPage[]>();
  private readonly byValue = new Map<string, Map<string, MapPage[]>>();

  constructor(pages: readonly MapPage[]) {
    for (const p of pages) {
      if (p.segments === undefined) continue;
      const list = this.byLength.get(p.segments.length);
      if (list === undefined) this.byLength.set(p.segments.length, [p]);
      else list.push(p);
    }
  }

  /**
   * The pages a pattern could match: those whose segment count fits it (its required segments up to all of them,
   * or any count from the required ones with a rest segment), narrowed to the pages holding its first literal
   * when every segment before that literal is required, so the literal's position is fixed.
   */
  candidates(pattern: readonly RouteSegment[]): MapPage[] {
    const rest = pattern.some((s) => s.kind === 'rest');
    const required = pattern.filter(
      (s) => s.kind !== 'rest' && !s.optional,
    ).length;
    const most = rest ? Number.POSITIVE_INFINITY : pattern.length;
    const at = pattern.findIndex((s) => s.kind !== 'param' || s.optional);
    const fixed = at === -1 ? undefined : pattern[at];
    const literal =
      fixed?.kind === 'literal' && !fixed.optional ? fixed.value : undefined;
    const out: MapPage[] = [];
    for (const [length, all] of this.byLength) {
      if (length < required || length > most) continue;
      out.push(...(literal === undefined ? all : this.at(length, at, literal)));
    }
    return out;
  }

  /** The pages of `length` segments whose segment at `position` is `value`. */
  private at(length: number, position: number, value: string): MapPage[] {
    const key = `${length}/${position}`;
    let index = this.byValue.get(key);
    if (index === undefined) {
      index = new Map();
      for (const p of this.byLength.get(length) ?? []) {
        const seg = p.segments?.[position];
        if (seg === undefined) continue;
        const list = index.get(seg);
        if (list === undefined) index.set(seg, [p]);
        else list.push(p);
      }
      this.byValue.set(key, index);
    }
    return index.get(value) ?? [];
  }
}

/**
 * For each distinct route path, the pages whose path it matches, in `pages` order. Declarations that share a path
 * share one entry; a page is only tested against a pattern its segment count and first fixed literal allow
 * (`PageBuckets`), so the number of `match` calls is far below routes × pages on a real app.
 *
 * @param match the matcher, `matchRoute` unless a test counts its calls.
 */
export function matchedPages(
  routes: readonly RouteRecord[],
  pages: readonly MapPage[],
  match: typeof matchRoute = matchRoute,
): Map<string, Set<MapPage>> {
  const buckets = new PageBuckets(pages);
  const order = new Map(pages.map((p, i) => [p, i]));
  const found = new Map<string, Set<MapPage>>();
  for (const { path } of routes) {
    if (found.has(path)) continue;
    const pattern = parseRoutePattern(path);
    const hits = buckets
      .candidates(pattern)
      .filter((p) => p.segments !== undefined && match(pattern, p.segments))
      .sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    found.set(path, new Set(hits));
  }
  return found;
}

/** Routes no page matches, by path, file, line and extractor. */
function unvisitedRoutes(
  routes: readonly RouteRecord[],
  found: ReadonlyMap<string, ReadonlySet<MapPage>>,
  truncated: boolean,
  redacted: boolean,
): CoverageGap[] {
  return routes
    .filter((r) => (found.get(r.path)?.size ?? 0) === 0)
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
  pages: readonly MapPage[],
  found: ReadonlyMap<string, ReadonlySet<MapPage>>,
): CoverageGap[] {
  const declared = new Set<MapPage>();
  for (const [path, hits] of found)
    if (!catchAll(parseRoutePattern(path)))
      for (const p of hits) declared.add(p);
  return pages
    .filter(
      (p) => served(p.page) && p.segments !== undefined && !declared.has(p),
    )
    .map((p) => ({
      kind: 'page_no_route',
      page: gapPage(p),
      caveats: caveats(['paths_redacted', p.redacted]),
    }));
}

/**
 * Each page path with the pointer of its first page in the map. Masking can make two pages share a path (`/u/***`);
 * the first, lowest `/pages/N`, is the one cited.
 */
export function pointersByPath(pages: readonly MapPage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of pages)
    if (!out.has(p.page.path)) out.set(p.page.path, p.pointer);
  return out;
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
 * @throws {ConfigError} when both `operations` and `report` are given, or the report does not fit `map` (another
 *   crawl, another truncation, or a screen the map does not hold).
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
    const found = matchedPages(index.routes, pages);
    checked.push('route_unvisited', 'page_no_route');
    gaps.push(
      ...unvisitedRoutes(index.routes, found, truncated, redactedPages > 0),
      ...undeclaredPages(pages, found),
    );
  }
  if (report !== undefined) {
    checked.push('operation_no_ui', 'operation_ambiguous');
    gaps.push(
      ...operationGaps(report, pointersByPath(pages), redactedPages > 0),
    );
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
