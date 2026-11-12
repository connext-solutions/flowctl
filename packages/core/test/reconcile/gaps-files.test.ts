import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/foundation/index.js';
import {
  buildCodeIndex,
  coverageGaps,
  CoverageGapsSchema,
  gapsJson,
  gapsMarkdown,
  writeGaps,
} from '../../src/reconcile/index.js';
import { openRoot } from '../../src/trust/index.js';
import { appMap, operation, page } from '../derive/build.js';
import { route, routesIndex } from './gaps-build.js';
import { put, tmp } from './repo.js';

/** Markdown with every code span removed, so what is left is the file's own text. */
const outsideCode = (md: string): string =>
  md.replace(/(`+) [\s\S]*? \1(?!`)/g, '');

const hostileMap = appMap([
  page('/a`<b>[c]', '# <img src=x onerror=alert(1)>\u202e'),
  page('/ok', 'Được'),
]);
const hostile = coverageGaps({
  index: routesIndex([
    route('/r', 'src/[x](javascript:alert(1))\u2028.tsx', 2),
    route('/ok', 'ok.tsx', 1),
  ]),
  map: { ...hostileMap, truncated: true },
  operations: [
    operation({
      id: 'evil',
      title: '=HYPERLINK("https://evil.example")\n## x',
      headings: ['Không có'],
      items: ['Có.'],
    }),
  ],
});

describe('coverage gap files (T6.4)', () => {
  it('keeps every untrusted string inside a code span, visible and defused', () => {
    const md = gapsMarkdown(hostile);
    const own = outsideCode(md);
    expect(own).not.toMatch(/[<>[\]`\u202e\u2028]/u);
    expect(own).not.toContain('https://');
    expect(md).not.toMatch(/[\u202e\u2028]/u);
    expect(md).toContain('⟨U+202E⟩');
    expect(md).toContain('⟨U+2028⟩');
    expect(md).toContain('`` /a`<b>[c] ``');
    expect(md).toContain(
      '` \'=HYPERLINK("https://evil.example")⟨U+000A⟩## x `',
    );
    expect(md.split('\n').filter((l) => l.startsWith('#'))).toEqual([
      '# Coverage gaps',
      '## Code routes no crawled page matches',
      '## Crawled pages no code route declares',
      '## Operations with no screen',
      '## Operations with tied screens',
      '## Pages no operation matched',
    ]);
  });

  it('says when the crawl stopped early and which gaps it may explain', () => {
    const md = gapsMarkdown(hostile);
    expect(md).toContain('The crawl stopped early');
    expect(md).toMatch(/- ` \/r ` .*\(crawl stopped early\)/);
    expect(gapsMarkdown(coverageGaps({}))).toContain(
      'Not checked (an input is missing): every kind.',
    );
  });

  it('writes JSON the schema accepts, that parses back to the gaps and hides no invisible character', () => {
    const json = gapsJson(hostile);
    expect(CoverageGapsSchema.parse(JSON.parse(json))).toEqual(hostile);
    expect(JSON.parse(json)).toEqual(hostile);
    expect(json).not.toMatch(/[\u202e\u2028]/u);
    expect(json).toContain('\\u202e');
  });

  it('writes both files inside the root, and refuses a directory outside it or behind a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowctl-gaps-'));
    const out = writeGaps(join(root, 'reconcile'), root, hostile);
    expect(readFileSync(out.markdown, 'utf8')).toBe(gapsMarkdown(hostile));
    expect(readFileSync(out.json, 'utf8')).toBe(gapsJson(hostile));
    expect(statSync(out.json).mtimeMs).toBeLessThanOrEqual(
      statSync(out.markdown).mtimeMs,
    );
    expect(() => writeGaps(tmpdir(), root, hostile)).toThrow(ConfigError);
    symlinkSync(tmpdir(), join(root, 'link'));
    expect(() => writeGaps(join(root, 'link', 'x'), root, hostile)).toThrow(
      ConfigError,
    );
  });

  it('refuses a gaps.json symlink already inside the root, and writes neither file', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowctl-gaps-'));
    const outside = join(mkdtempSync(join(tmpdir(), 'flowctl-gaps-out-')), 't');
    writeFileSync(outside, 'keep');
    symlinkSync(outside, join(root, 'gaps.json'));
    expect(() => writeGaps(root, root, hostile)).toThrow(ConfigError);
    expect(readFileSync(outside, 'utf8')).toBe('keep');
    expect(lstatSync(join(root, 'gaps.json')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(root, 'gaps.md'))).toBe(false);
  });

  it('says "1 gap." for a single gap', () => {
    const one = coverageGaps({
      index: routesIndex([route('/r', 'r.tsx', 1)]),
      map: appMap([]),
    });
    expect(gapsMarkdown(one)).toContain(' 1 gap.\n');
    expect(gapsMarkdown(hostile)).toMatch(/ \d+ gaps\./);
  });

  it('refuses gaps whose checked kinds repeat or miss the kind of a gap', () => {
    expect(() =>
      CoverageGapsSchema.parse({
        ...hostile,
        checked: [...hostile.checked, 'route_unvisited'],
      }),
    ).toThrow(/checked/);
    expect(() =>
      CoverageGapsSchema.parse({
        ...hostile,
        checked: hostile.checked.filter((k) => k !== 'page_no_route'),
      }),
    ).toThrow(/page_no_route/);
  });

  it('refuses to write gaps that do not fit the schema', () => {
    const root = mkdtempSync(join(tmpdir(), 'flowctl-gaps-'));
    expect(() =>
      writeGaps(root, root, { ...hostile, v: 2 } as unknown as typeof hostile),
    ).toThrow();
  });
});

describe('coverage gaps over a real code index (T6.4)', () => {
  it('joins routes of React Router objects, Next.js and Remix files to a hand-written map', () => {
    const dir = tmp();
    put(
      dir,
      'src/router.tsx',
      [
        "import { createBrowserRouter } from 'react-router-dom';",
        'export const router = createBrowserRouter([',
        "  { path: '/shop/orders', children: [{ path: ':id' }] },",
        "  { path: '/shop/reports' },",
        ']);',
      ].join('\n'),
    );
    put(dir, 'app/page.tsx', 'export default () => null;');
    put(dir, 'app/items/[id]/page.tsx', 'export default () => null;');
    put(dir, 'app/routes/docs.$.tsx', 'export default () => null;');
    const index = buildCodeIndex(openRoot(dir, 'repos'));
    const map = appMap([
      page('/', 'Trang chủ'),
      page('/shop/orders', 'Đơn hàng'),
      page('/shop/orders/9', 'Đơn 9'),
      page('/items/abc', 'Mục'),
      page('/docs/a/b', 'Tài liệu'),
      page('/help', 'Trợ giúp'),
    ]);
    const gaps = coverageGaps({ index, map });
    expect(
      gaps.gaps.map((g) =>
        g.kind === 'route_unvisited'
          ? [g.kind, g.route.path, g.route.file, g.route.line, g.route.source]
          : g.kind === 'page_no_route'
            ? [g.kind, g.page.path, g.page.pointer]
            : [g.kind],
      ),
    ).toEqual([
      [
        'route_unvisited',
        '/shop/reports',
        'src/router.tsx',
        4,
        'route-objects',
      ],
      ['page_no_route', '/help', '/pages/5'],
    ]);
  });
});
