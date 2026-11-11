import type { Token } from './lexer.js';
import { joinRoute } from './route-match.js';

/** A route found in one file: its full path, the pattern as declared, the line of the pattern. */
export interface FoundRoute {
  path: string;
  pattern: string;
  line: number;
}

/** A route declaration and the declaration it is nested in (`null` at the top). */
interface RouteNode {
  parent: number | null;
  pattern: string | null;
  line: number;
}

/** Full paths of every node with a pattern, in declaration order; a node's prefix comes from its ancestors. */
function resolve(nodes: readonly RouteNode[]): FoundRoute[] {
  const full = (id: number | null): string | null => {
    let path: string | null = null;
    const chain: string[] = [];
    for (let at = id; at !== null; at = nodes[at]?.parent ?? null) {
      const p = nodes[at]?.pattern;
      if (p !== null && p !== undefined) chain.push(p);
      if (p?.startsWith('/') === true) break;
    }
    for (const p of chain.reverse()) path = joinRoute(path, p);
    return path;
  };
  const out: FoundRoute[] = [];
  nodes.forEach((n, id) => {
    if (n.pattern === null) return;
    out.push({ path: full(id) ?? '/', pattern: n.pattern, line: n.line });
  });
  return out;
}

const ROUTE_TAG = /^(?:Route|[A-Z][\w$]*Route)$/;

/**
 * Routes declared as JSX elements (React Router `<Route path="…">`, and wrappers named `…Route` such as
 * `<PrivateRoute>`): a `path` attribute given as a string or `{"…"}` (every literal inside braces counts, so
 * `path={["/a", "/b"]}` gives both); nested elements join their parent's path. A computed path is left out.
 */
export function jsxRoutes(toks: readonly Token[]): FoundRoute[] {
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
export function objectRoutes(toks: readonly Token[]): FoundRoute[] {
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
