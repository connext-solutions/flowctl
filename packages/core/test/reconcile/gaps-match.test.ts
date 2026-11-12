import { describe, expect, it } from 'vitest';
import {
  matchRoute,
  parseRoutePattern,
} from '../../src/reconcile/code/index.js';
import { coverageGaps } from '../../src/reconcile/index.js';
import { matchedPages } from '../../src/reconcile/gaps/find.js';
import { mapPages } from '../../src/reconcile/gaps/pages.js';
import { appMap, page } from '../derive/build.js';
import { route, routesIndex } from './gaps-build.js';

describe('route matching (T6.4)', () => {
  it('counts the root route as declaring the root page', () => {
    const gaps = coverageGaps({
      index: routesIndex([
        route('/', 'src/router.tsx', 1),
        route('/*', 'src/router.tsx', 2, '*'),
      ]),
      map: appMap([page('/', 'Trang chủ'), page('/lost', 'Lạc')]),
    });
    expect(
      gaps.gaps.map((g) => [
        g.kind,
        g.kind === 'page_no_route' ? g.page.path : null,
      ]),
    ).toEqual([['page_no_route', '/lost']]);
  });

  it('counts a route as visited when its only page answered an error status', () => {
    const gaps = coverageGaps({
      index: routesIndex([route('/gone', 'src/router.tsx', 1)]),
      map: appMap([{ ...page('/gone', 'Không thấy'), status: 404 }]),
    });
    expect(gaps.gaps).toEqual([]);
  });

  const mixed = [
    route('/', 'a.tsx', 1),
    route('/a', 'a.tsx', 2),
    route('/a/:id', 'a.tsx', 3),
    route('/a/:id?/edit', 'a.tsx', 4),
    route('/a/*', 'a.tsx', 5),
    route('/:x/b', 'a.tsx', 6),
    route('/opt?/c', 'a.tsx', 7),
    route('/:x/:y?/a', 'a.tsx', 10),
    route('/:x/:y/edit', 'a.tsx', 11),
    route('/*', 'a.tsx', 8),
    route('/a/:id', 'b.tsx', 9),
  ];
  const paths = [
    '/',
    '/a',
    '/a/1',
    '/a/edit',
    '/a/1/edit',
    '/z/b',
    '/c',
    '/opt/c',
    '/a/1/2/3',
  ];

  it('finds for each route path exactly the pages a full scan finds', () => {
    const pages = mapPages(appMap(paths.map((p) => page(p, p))));
    const found = matchedPages(mixed, pages);
    for (const r of mixed) {
      const pattern = parseRoutePattern(r.path);
      const want = pages
        .filter(
          (p) => p.segments !== undefined && matchRoute(pattern, p.segments),
        )
        .map((p) => p.page.path);
      expect([...(found.get(r.path) ?? [])].map((p) => p.page.path)).toEqual(
        want,
      );
    }
  });

  it.each([
    ['', ''],
    ['/:org', '/o'],
  ])(
    'matches 10k distinct routes (prefix %j) against 1k pages with a small share of the full product',
    (prefix, org) => {
      const shapes = [
        '',
        '/:id',
        '/:id?',
        '/edit',
        '/:id/edit',
        '/*',
        '/a/b/:c',
      ];
      const routes = Array.from({ length: 10_000 }, (_, i) =>
        route(
          `${prefix}/s${i % 40}/r${i}${shapes[i % shapes.length]}`,
          'r.tsx',
          i + 1,
        ),
      );
      const pages = mapPages(
        appMap(
          Array.from({ length: 1000 }, (_, j) =>
            page(
              `${org}/s${j % 40}/r${(j * 7) % 10_000}${j % 3 === 0 ? '' : `/${j}`}${j % 5 === 0 ? '/edit' : ''}`,
              'P',
            ),
          ),
        ),
      );
      let calls = 0;
      const counted: typeof matchRoute = (p, s) => {
        calls++;
        return matchRoute(p, s);
      };
      const found = matchedPages([...routes, ...routes], pages, counted);
      expect(found.size).toBe(10_000);
      expect(calls).toBeLessThan(500_000);
    },
  );
});
