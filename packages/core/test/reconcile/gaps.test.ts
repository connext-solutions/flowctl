import { describe, expect, it } from 'vitest';
import { matchOperations } from '../../src/derive/index.js';
import { ConfigError } from '../../src/foundation/index.js';
import { coverageGaps, type CoverageGap } from '../../src/reconcile/index.js';
import { appMap, operation, page } from '../derive/build.js';
import { route, routesIndex } from './gaps-build.js';

const ROUTES = [
  route('/orders/:id', 'src/router.tsx', 3, ':id'),
  route('/reports', 'src/router.tsx', 9),
  route('/settings/:tab?', 'src/router.tsx', 5, ':tab?'),
  route('/shop/:id', 'app/shop/[id]/page.tsx', 1, '[id]', 'next-app'),
  route('/files/*', 'app/routes/files.$.tsx', 1, '$', 'remix'),
  route('/café', 'src/router.tsx', 7),
  route('/admin/users', 'src/admin.tsx', 2),
  route('/*', 'src/router.tsx', 12, '*'),
];

const PAGES = [
  page('/orders/42', 'Đơn hàng'),
  page('/settings', 'Cài đặt'),
  page('/shop/7', 'Cửa hàng'),
  page('/files/a/b.txt', 'Tệp'),
  page('/caf%C3%A9', 'Quán'),
  page('/legacy', 'Cũ'),
  { ...page('/gone', 'Không thấy'), status: 404 },
];

const brief = (g: CoverageGap): unknown[] => {
  switch (g.kind) {
    case 'route_unvisited':
      return [g.kind, g.route.path, g.route.file, g.route.line, g.caveats];
    case 'page_no_route':
    case 'page_no_spec':
      return [g.kind, g.page.path, g.page.pointer, g.caveats];
    case 'operation_no_ui':
      return [g.kind, g.operation.id, g.operation.index, g.caveats];
    case 'operation_ambiguous':
      return [g.kind, g.operation.id, g.pages, g.caveats];
  }
};

describe('coverageGaps: code and map (T6.4)', () => {
  it('lists each code route no crawled page matches, with its file and line', () => {
    const gaps = coverageGaps({
      index: routesIndex(ROUTES),
      map: appMap(PAGES),
    });
    expect(gaps.checked).toEqual(['route_unvisited', 'page_no_route']);
    expect(
      gaps.gaps.filter((g) => g.kind === 'route_unvisited').map(brief),
    ).toEqual([
      ['route_unvisited', '/admin/users', 'src/admin.tsx', 2, []],
      ['route_unvisited', '/reports', 'src/router.tsx', 9, []],
    ]);
  });

  it('lists each page no route declares; a catch-all and an error page do not count', () => {
    const gaps = coverageGaps({
      index: routesIndex(ROUTES),
      map: appMap(PAGES),
    });
    expect(
      gaps.gaps.filter((g) => g.kind === 'page_no_route').map(brief),
    ).toEqual([['page_no_route', '/legacy', '/pages/5', []]]);
  });

  it('gives the same gaps whatever order routes and pages come in', () => {
    const a = coverageGaps({ index: routesIndex(ROUTES), map: appMap(PAGES) });
    const b = coverageGaps({
      index: routesIndex([...ROUTES].reverse()),
      map: appMap([...PAGES].reverse()),
    });
    expect(b.gaps.map((g) => g.kind)).toEqual(a.gaps.map((g) => g.kind));
    expect(b.gaps.map(brief).map((x) => x.slice(0, 2))).toEqual(
      a.gaps.map(brief).map((x) => x.slice(0, 2)),
    );
  });

  it('lists a route declared twice once per declaration', () => {
    const gaps = coverageGaps({
      index: routesIndex([route('/x', 'b.tsx', 1), route('/x', 'a.tsx', 4)]),
      map: appMap([]),
    });
    expect(gaps.gaps.map(brief)).toEqual([
      ['route_unvisited', '/x', 'a.tsx', 4, []],
      ['route_unvisited', '/x', 'b.tsx', 1, []],
    ]);
  });
});

const form = operation({
  id: 'leave-submit',
  headings: ['Đơn từ'],
  steps: ['Nhập "Lý do".'],
  items: ['Có.'],
});
const lost = operation({ id: 'lost', headings: ['Không có'], items: ['Có.'] });
const twin = operation({ id: 'twin', headings: ['Trùng'], items: ['Có.'] });
const SPEC_MAP = appMap([
  page('/requests', 'Đơn từ', ['textbox:Lý do']),
  page('/t1', 'Trùng'),
  page('/t2', 'Trùng'),
  page('/about', 'Giới thiệu'),
  { ...page('/broken', 'Lỗi'), status: 500 },
]);

describe('coverageGaps: spec and map (T6.4)', () => {
  it('lists operations with no screen, operations with tied screens, and pages no operation claims', () => {
    const report = matchOperations([twin, form, lost], SPEC_MAP);
    const gaps = coverageGaps({ map: SPEC_MAP, report });
    expect(gaps.checked).toEqual([
      'operation_no_ui',
      'operation_ambiguous',
      'page_no_spec',
    ]);
    expect(gaps.gaps.map(brief)).toEqual([
      ['operation_no_ui', 'lost', 1, []],
      [
        'operation_ambiguous',
        'twin',
        [
          { path: '/t1', pointer: '/pages/1' },
          { path: '/t2', pointer: '/pages/2' },
        ],
        [],
      ],
      ['page_no_spec', '/about', '/pages/3', []],
    ]);
    const lostGap = gaps.gaps[0];
    expect(lostGap?.kind === 'operation_no_ui' && lostGap.operation).toEqual({
      id: 'lost',
      title: 'lost',
      provider: 'markdown',
      ref: 'lost.md',
      index: 1,
    });
  });

  it('matches operations itself when given operations and a map', () => {
    const fromOps = coverageGaps({
      map: SPEC_MAP,
      operations: [form, lost, twin],
    });
    const fromReport = coverageGaps({
      map: SPEC_MAP,
      report: matchOperations([form, lost, twin], SPEC_MAP),
    });
    expect(fromOps).toEqual(fromReport);
  });

  it('checks only the operation kinds from a report alone, with no page pointers', () => {
    const gaps = coverageGaps({ report: matchOperations([twin], SPEC_MAP) });
    expect(gaps.checked).toEqual(['operation_no_ui', 'operation_ambiguous']);
    expect(gaps.origin).toBe(SPEC_MAP.origin);
    expect(gaps.gaps.map(brief)).toEqual([
      [
        'operation_ambiguous',
        'twin',
        [
          { path: '/t1', pointer: null },
          { path: '/t2', pointer: null },
        ],
        [],
      ],
    ]);
  });

  it('checks nothing without inputs, and nothing about spec from operations without a map', () => {
    expect(coverageGaps({})).toEqual({
      v: 1,
      origin: null,
      observedAt: null,
      truncated: false,
      redactedPages: 0,
      checked: [],
      gaps: [],
    });
    expect(coverageGaps({ operations: [form] }).checked).toEqual([]);
    expect(coverageGaps({ index: routesIndex(ROUTES) }).checked).toEqual([]);
  });

  it('refuses a report of another crawl than the map, and both operations and a report', () => {
    const report = matchOperations([form], SPEC_MAP);
    expect(() =>
      coverageGaps({
        map: { ...SPEC_MAP, observedAt: '2026-11-21T00:00:00.000Z' },
        report,
      }),
    ).toThrow(ConfigError);
    expect(() =>
      coverageGaps({ map: SPEC_MAP, operations: [form], report }),
    ).toThrow(ConfigError);
  });
});

describe('coverageGaps: truncated crawls and redacted paths (T6.4)', () => {
  it('labels the gaps a stopped crawl may explain, and only those', () => {
    const map = { ...SPEC_MAP, truncated: true };
    const gaps = coverageGaps({
      index: routesIndex([route('/reports', 'r.tsx', 1)]),
      map,
      operations: [lost, twin],
    });
    expect(gaps.truncated).toBe(true);
    expect(gaps.gaps.map((g) => [g.kind, g.caveats])).toEqual([
      ['route_unvisited', ['crawl_truncated']],
      ['page_no_route', []],
      ['page_no_route', []],
      ['page_no_route', []],
      ['page_no_route', []],
      ['operation_no_ui', ['crawl_truncated']],
      ['operation_ambiguous', ['crawl_truncated']],
      ['page_no_spec', []],
      ['page_no_spec', []],
    ]);
  });

  it('uses a redacted path as the map holds it and labels what the mask may hide', () => {
    const map = appMap([
      page('/users/***', 'Người dùng'),
      page('/x/***/edit', 'Sửa'),
    ]);
    const gaps = coverageGaps({
      index: routesIndex([
        route('/users/:id', 'u.tsx', 1),
        route('/x/settings/edit', 'x.tsx', 1),
      ]),
      map,
      report: matchOperations([], map),
    });
    expect(gaps.redactedPages).toBe(2);
    expect(gaps.gaps.map(brief)).toEqual([
      ['route_unvisited', '/x/settings/edit', 'x.tsx', 1, ['paths_redacted']],
      ['page_no_route', '/x/***/edit', '/pages/1', ['paths_redacted']],
      ['page_no_spec', '/users/***', '/pages/0', ['paths_redacted']],
      ['page_no_spec', '/x/***/edit', '/pages/1', ['paths_redacted']],
    ]);
  });
});
