import type { AppMap, AppPage } from '../../observe/index.js';
import { MASK } from '../../run/index.js';
import { routeQuerySegments } from '../code/index.js';
import type { GapCaveat, GapPage } from './schema.js';

/** A page of the map with its pointer, its path as route segments (`undefined` when refused) and its mask flag. */
export interface MapPage {
  page: AppPage;
  pointer: string;
  segments: string[] | undefined;
  redacted: boolean;
}

/** Compares two strings by UTF-16 code units. */
export const byCode = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

/** A page that served a document (2xx or 3xx): an error or unreachable page is a free-check finding, not UI. */
export const served = (p: AppPage): boolean =>
  p.status >= 200 && p.status < 400;

/** The caveats whose condition holds, in the order given. */
export const caveats = (...on: [GapCaveat, boolean][]): GapCaveat[] =>
  on.filter(([, yes]) => yes).map(([c]) => c);

/** A page as a gap cites it. */
export const gapPage = (p: MapPage): GapPage => ({
  path: p.page.path,
  title: p.page.title,
  status: p.page.status,
  pointer: p.pointer,
});

/**
 * The pages of `map` sorted by path, each with its `/pages/N` pointer, its path as the code index splits a query
 * (`routeQuerySegments`) and whether it holds the redaction mask. The path is used as the map holds it.
 */
export function mapPages(map: AppMap | undefined): MapPage[] {
  return (map?.pages ?? [])
    .map((page, i) => ({
      page,
      pointer: `/pages/${i}`,
      segments: routeQuerySegments(page.path),
      redacted: page.path.includes(MASK),
    }))
    .sort((a, b) => byCode(a.page.path, b.page.path));
}
