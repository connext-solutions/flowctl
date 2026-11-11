import { nextAppRoute, nextPagesRoute, remixRoute } from './file-routes.js';
import { lex, type Token } from './lexer.js';
import { type FoundRoute, jsxRoutes, objectRoutes } from './source-routes.js';

/**
 * One way an app declares routes. An extractor reads the file's path (`fromPath`, file-system routing), its
 * source (`fromSource`, router declarations), or both. Add a framework by adding an entry to
 * {@link ROUTE_EXTRACTORS} or by passing a list to `buildCodeIndex`.
 */
export interface RouteExtractor {
  readonly name: string;
  /** The route the path `rel` declares, or `undefined`. */
  fromPath?(rel: string): string | undefined;
  /** Whether {@link fromSource} should read this file (cheap: a file name or a marker in the text). */
  reads?(rel: string, text: string): boolean;
  /** The routes declared in the tokens of one file. */
  fromSource?(toks: readonly Token[]): FoundRoute[];
}

const JSX_FILE = /\.(?:[cm]?jsx?|tsx)$/;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|vue)$/;

/** A word that marks a file as a router declaration, so a `path:` key elsewhere is not read as a route. */
const ROUTER_MARKER =
  /\b(?:create(?:Browser|Hash|Memory|Static)Router|useRoutes|RouteObject|createRouter|RouteRecordRaw|RouterModule|provideRouter|Routes)\b/;

/**
 * The built-in extractors, in the order their routes are reported for one file:
 * - `react-router-jsx`: `<Route path="…">` elements (and `…Route` wrappers), nested elements joined;
 * - `route-objects`: `{ path: '…', children: [...] }` objects in a file that names a router API
 *   (`createBrowserRouter`, `useRoutes`, Vue `createRouter` / `RouteRecordRaw`, Angular `Routes` /
 *   `RouterModule` / `provideRouter`);
 * - `next-app`, `next-pages`, `remix`: file-system routes from the file's path.
 */
export const ROUTE_EXTRACTORS: readonly RouteExtractor[] = [
  {
    name: 'react-router-jsx',
    reads: (rel, text) => JSX_FILE.test(rel) && text.includes('Route'),
    fromSource: jsxRoutes,
  },
  {
    name: 'route-objects',
    reads: (rel, text) => SCRIPT_FILE.test(rel) && ROUTER_MARKER.test(text),
    fromSource: objectRoutes,
  },
  { name: 'next-app', fromPath: nextAppRoute },
  { name: 'next-pages', fromPath: nextPagesRoute },
  { name: 'remix', fromPath: remixRoute },
];

/** A route one extractor found, with the extractor's name. */
export interface ExtractedRoute extends FoundRoute {
  source: string;
}

/**
 * The routes declared in one file by `extractors`: file-system routes (line 1, the pattern is the path) and
 * router declarations in the source, in extractor order. `toks` is lexed once, on first use.
 */
export function extractRoutes(
  rel: string,
  text: string | undefined,
  extractors: readonly RouteExtractor[] = ROUTE_EXTRACTORS,
  toks: () => readonly Token[] = () => lex(text ?? ''),
): ExtractedRoute[] {
  const out: ExtractedRoute[] = [];
  let cached: readonly Token[] | undefined;
  const tokens = (): readonly Token[] => (cached ??= toks());
  for (const ex of extractors) {
    const path = ex.fromPath?.(rel);
    if (path !== undefined)
      out.push({ path, pattern: path, line: 1, source: ex.name });
    if (
      text !== undefined &&
      ex.fromSource !== undefined &&
      (ex.reads?.(rel, text) ?? true)
    )
      for (const r of ex.fromSource(tokens()))
        out.push({ ...r, source: ex.name });
  }
  return out;
}

/** The routes the source `text` of `rel` declares with the built-in extractors (router declarations only). */
export const routesInSource = (rel: string, text: string): ExtractedRoute[] =>
  extractRoutes(
    rel,
    text,
    ROUTE_EXTRACTORS.filter((e) => e.fromSource !== undefined),
  );
