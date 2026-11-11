import { joinRoute } from './route-match.js';

/** A route a file's path declares, and the convention that declared it. */
export interface PathRoute {
  path: string;
  source: 'next-app' | 'next-pages' | 'remix';
}

const PAGE_EXT = /\.(?:[cm]?[jt]sx?|mdx?)$/;

/** A Next.js dynamic segment as a pattern segment: `[id]` is `:id`, `[...x]` and `[[...x]]` are `*`. */
function nextSegment(seg: string): string {
  if (/^\[\[?\.\.\.[^\]]+\]\]?$/.test(seg)) return '*';
  const param = /^\[([^\]]+)\]$/.exec(seg);
  return param === null ? seg : `:${param[1] ?? ''}`;
}

/**
 * Next.js App Router: `app/**\/page.*` or `route.*` (also under `src/`). Route groups `(x)` and parallel slots
 * `@x` add no segment; a private folder `_x` or an intercepting folder `(.)x` is not routed.
 */
export function nextAppRoute(rel: string): string | undefined {
  if (rel.startsWith('app/routes/')) return undefined;
  const m = /^(?:src\/)?app\/(?:(.*)\/)?(?:page|route)\.[^/]+$/.exec(rel);
  if (m === null || !PAGE_EXT.test(rel)) return undefined;
  const segs = (m[1] ?? '').split('/').filter((s) => s !== '');
  if (segs.some((s) => s.startsWith('_') || /^\(\.+\)/.test(s)))
    return undefined;
  const kept = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@'));
  return joinRoute(null, kept.map(nextSegment).join('/'));
}

/** Next.js Pages Router: `pages/**\/*.*` (also under `src/`); `index` is its folder; `_app`, `_document` are not routes. */
export function nextPagesRoute(rel: string): string | undefined {
  const m = /^(?:src\/)?pages\/(.+)$/.exec(rel);
  if (m === null || !PAGE_EXT.test(rel)) return undefined;
  const segs = (m[1] ?? '').replace(PAGE_EXT, '').split('/');
  if (segs.some((s) => s.startsWith('_'))) return undefined;
  if (segs.at(-1) === 'index') segs.pop();
  return joinRoute(null, segs.map(nextSegment).join('/'));
}

/** One Remix flat-route segment: `$id` is `:id`, `$` is `*`, `($id)` is `:id?`, a leading `_` adds nothing. */
function remixSegment(seg: string): string | undefined {
  const s = seg.replace(/_$/, '');
  if (s === '$') return '*';
  if (s.startsWith('_')) return undefined;
  const optional = /^\((.*)\)$/.exec(s);
  const inner = optional?.[1] ?? s;
  const named = inner.startsWith('$') ? `:${inner.slice(1)}` : inner;
  return optional === null ? named : `${named}?`;
}

/** Stands in for an escaped `[.]` while a Remix route name is split on dots (a noncharacter, never in a name). */
const DOT = '\uffff';

/**
 * Remix flat routes (v2): `app/routes/<name>.*` or `app/routes/<name>/route.*`, where `.` separates segments
 * (`[.]` escapes a dot) and `_index` is the parent's index route.
 */
export function remixRoute(rel: string): string | undefined {
  const m = /^app\/routes\/([^/]+?)(?:\/route)?(\.[^/.]+)$/.exec(rel);
  if (m === null || !PAGE_EXT.test(m[2] ?? '')) return undefined;
  const name = m[1] ?? '';
  const segs = name
    .replace(/\[\.\]/g, DOT)
    .split('.')
    .map((s) => s.replaceAll(DOT, '.'))
    .filter((s) => s !== '_index')
    .map(remixSegment)
    .filter((s): s is string => s !== undefined);
  return joinRoute(null, segs.join('/'));
}

/**
 * The route the file path `rel` declares by a file-system routing convention (Remix, Next.js App Router,
 * Next.js Pages Router), or `undefined`. The conventions exclude one another, so the order here (Remix, then the
 * App Router, then the Pages Router) only matters for a custom extractor list.
 *
 * @internal for the package's tests; `buildCodeIndex` runs every extractor of its list on each path.
 * @example fileRoute('src/app/orders/[id]/page.tsx') // { path: '/orders/:id', source: 'next-app' }
 */
export function fileRoute(rel: string): PathRoute | undefined {
  const remix = remixRoute(rel);
  if (remix !== undefined) return { path: remix, source: 'remix' };
  const app = nextAppRoute(rel);
  if (app !== undefined) return { path: app, source: 'next-app' };
  const pages = nextPagesRoute(rel);
  return pages === undefined
    ? undefined
    : { path: pages, source: 'next-pages' };
}
