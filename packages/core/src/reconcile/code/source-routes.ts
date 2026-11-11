import type { Token } from './lexer.js';
import {
  joinRoute,
  MAX_ROUTE_CHARS,
  MAX_ROUTE_SEGMENTS,
} from './route-match.js';

/** A route found in one file: its full path, the pattern as declared, the line of the pattern. */
export interface FoundRoute {
  path: string;
  pattern: string;
  line: number;
}

/** A route declaration left out of one file, with its line and why. */
export interface RouteSkip {
  line: number;
  rule: 'route too deep' | 'route too long';
}

/** What one source extractor found in one file. */
export interface SourceRoutes {
  routes: FoundRoute[];
  skipped: RouteSkip[];
}

/** Most route declarations nested in one another that are read; deeper ones could only give an over-long path. */
export const MAX_ROUTE_NESTING = MAX_ROUTE_SEGMENTS;

/** A route declaration and the declaration it is nested in (`null` at the top). */
interface RouteNode {
  parent: number | null;
  pattern: string | null;
  line: number;
}

/** Marks a node that is left out; its relative descendants are left out with it. */
const DROPPED = false;

/**
 * Full paths of every node with a pattern, in declaration order. Parents come before their children, so each full
 * path is joined once from the parent's (linear in the number of nodes, each join bounded by
 * {@link MAX_ROUTE_CHARS}).
 *
 * @remarks A node nested deeper than {@link MAX_ROUTE_NESTING} is `route too deep`, and a path over
 *   {@link MAX_ROUTE_SEGMENTS} segments or {@link MAX_ROUTE_CHARS} characters is `route too long`. Only the first
 *   such node of a branch is reported; what is nested below it is left out silently, except an absolute path below
 *   an over-long one, which does not depend on it.
 */
function resolve(nodes: readonly RouteNode[]): SourceRoutes {
  const full: (string | null | typeof DROPPED)[] = [];
  const depth: number[] = [];
  const out: SourceRoutes = { routes: [], skipped: [] };
  nodes.forEach((n, id) => {
    const above = n.parent === null ? 0 : (depth[n.parent] ?? 0);
    depth[id] = above + 1;
    full[id] = DROPPED;
    if (above >= MAX_ROUTE_NESTING) {
      if (above === MAX_ROUTE_NESTING)
        out.skipped.push({ line: n.line, rule: 'route too deep' });
      return;
    }
    const up = n.parent === null ? null : (full[n.parent] ?? null);
    const absolute = n.pattern?.startsWith('/') === true;
    if (up === DROPPED && !absolute) return;
    if (n.pattern === null) {
      full[id] = up;
      return;
    }
    const path =
      n.pattern.length > MAX_ROUTE_CHARS
        ? undefined
        : joinRoute(up === DROPPED ? null : up, n.pattern);
    if (
      path === undefined ||
      path.length > MAX_ROUTE_CHARS ||
      path.split('/').length - 1 > MAX_ROUTE_SEGMENTS
    ) {
      out.skipped.push({ line: n.line, rule: 'route too long' });
      return;
    }
    full[id] = path;
    out.routes.push({ path, pattern: n.pattern, line: n.line });
  });
  return out;
}

const ROUTE_TAG = /^(?:Route|[A-Z][\w$]*Route)$/;

/**
 * Routes declared as JSX elements (React Router `<Route path="…">`, and wrappers named `…Route` such as
 * `<PrivateRoute>`): a `path` attribute given as a string or `{"…"}` (every literal inside braces counts, so
 * `path={["/a", "/b"]}` gives both); nested elements join their parent's path. A computed path is left out.
 */
export function jsxRoutes(toks: readonly Token[]): SourceRoutes {
  const nodes: RouteNode[] = [];
  const open: number[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const name = toks[i + 1];
    if (t?.value !== '<' || name === undefined) continue;
    if (name.value === '/' && ROUTE_TAG.test(toks[i + 2]?.value ?? '')) {
      open.pop();
      continue;
    }
    if (name.type !== 'id' || !ROUTE_TAG.test(name.value)) continue;
    const parent = open.at(-1) ?? null;
    const paths: Token[] = [];
    let depth = 0;
    let j = i + 2;
    let selfClosing = false;
    for (; j < toks.length; j++) {
      const a = toks[j];
      if (a === undefined) break;
      if (a.value === '{') depth++;
      else if (a.value === '}') depth--;
      else if (depth === 0 && a.value === '>') {
        selfClosing = toks[j - 1]?.value === '/';
        break;
      } else if (
        depth === 0 &&
        a.type === 'id' &&
        a.value === 'path' &&
        toks[j + 1]?.value === '='
      )
        paths.push(...attrStrings(toks, j + 2));
    }
    const ids = paths.map((p) => {
      nodes.push({ parent, pattern: p.value, line: p.line });
      return nodes.length - 1;
    });
    if (ids.length === 0)
      nodes.push({ parent, pattern: null, line: name.line });
    if (!selfClosing) open.push(ids[0] ?? nodes.length - 1);
    i = j;
  }
  return resolve(nodes);
}

/** Most tokens of one `path={…}` attribute value that are read. */
const MAX_ATTR_TOKENS = 200;

/** The string literals of the attribute value starting at `k`: one string, or every string inside `{…}`. */
function attrStrings(toks: readonly Token[], k: number): Token[] {
  const first = toks[k];
  if (first?.type === 'str') return [first];
  if (first?.value !== '{') return [];
  const out: Token[] = [];
  const stop = Math.min(toks.length, k + MAX_ATTR_TOKENS);
  for (let depth = 0; k < stop; k++) {
    const t = toks[k];
    if (t === undefined) break;
    if (t.value === '{') depth++;
    else if (t.value === '}' && --depth === 0) break;
    else if (t.type === 'str') out.push(t);
    else if (t.type === 'id') return [];
  }
  return out;
}

/** A frame of the object scanner: an object (maybe a route node), an array (with the key it is the value of), a call. */
type Frame =
  | { kind: '{'; node: number; key: string | null }
  | { kind: '[' | '('; key: string | null };

/**
 * Routes declared as objects with a `path` key (React Router `createBrowserRouter`, Vue Router `routes`, Angular
 * `Routes`): an object inside the `children` array of another route object joins its parent's path, whichever
 * order the keys come in. Only a literal `path` value counts.
 */
export function objectRoutes(toks: readonly Token[]): SourceRoutes {
  const nodes: RouteNode[] = [];
  const stack: Frame[] = [];
  let key: string | null = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t === undefined) break;
    const top = stack.at(-1);
    if (t.value === '{') {
      const holder = stack.at(-2);
      const parent =
        top?.kind === '[' && top.key === 'children' && holder?.kind === '{'
          ? holder.node
          : null;
      nodes.push({ parent, pattern: null, line: t.line });
      stack.push({ kind: '{', node: nodes.length - 1, key });
      key = null;
    } else if (t.value === '[' || t.value === '(') {
      stack.push({ kind: t.value, key });
      key = null;
    } else if (t.value === '}' || t.value === ']' || t.value === ')') {
      stack.pop();
      key = null;
    } else if (t.value === ',') key = null;
    else if (
      top?.kind === '{' &&
      (t.type === 'id' || t.type === 'str') &&
      toks[i + 1]?.value === ':'
    ) {
      key = t.value;
      i++;
      const v = toks[i + 1];
      const node = nodes[top.node];
      if (key === 'path' && v?.type === 'str' && node !== undefined) {
        node.pattern = v.value;
        node.line = v.line;
      }
    }
  }
  return resolve(nodes);
}
