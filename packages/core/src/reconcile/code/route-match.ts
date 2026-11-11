/**
 * One segment of a route pattern: a literal (optional when it ends in `?`), a parameter (`:id`, `:id?`, a
 * `:name(regex)` is a parameter whose regex is not checked), or the rest of the path (`*`, `**`, `:name*`,
 * `:name+`, `:name(.*)*`), which matches any number of segments.
 */
export type RouteSegment =
  | { kind: 'literal'; value: string; optional: boolean }
  | { kind: 'param'; optional: boolean }
  | { kind: 'rest' };

/** Most segments of a pattern the index keeps; a longer pattern is not indexed. */
export const MAX_ROUTE_SEGMENTS = 32;

/** The segments of a route pattern; empty segments are dropped, so `/a//b/` is `a`, `b`. */
export function parseRoutePattern(pattern: string): RouteSegment[] {
  return pattern
    .split('/')
    .filter((s) => s !== '')
    .map((s): RouteSegment => {
      if (s === '*' || s === '**') return { kind: 'rest' };
      if (s.startsWith(':')) {
        const tail = s.replace(/^:[^(?*+]*(?:\(.*\))?/, '');
        if (tail === '*' || tail === '+') return { kind: 'rest' };
        return { kind: 'param', optional: tail === '?' };
      }
      return s.endsWith('?') && s.length > 1
        ? { kind: 'literal', value: s.slice(0, -1), optional: true }
        : { kind: 'literal', value: s, optional: false };
    });
}

/**
 * Whether `segments` (a concrete path, split on `/`, empty parts dropped) match `pattern` exactly: every literal
 * equal byte for byte, a parameter one non-empty segment, an optional part zero or one, a rest any number.
 * A table over (pattern position, path position), so optional and rest parts cannot backtrack exponentially.
 */
export function matchRoute(
  pattern: readonly RouteSegment[],
  segments: readonly string[],
): boolean {
  const n = segments.length;
  let reach = Array.from({ length: n + 1 }, () => false);
  reach[0] = true;
  for (const part of pattern) {
    const next = Array.from({ length: n + 1 }, () => false);
    for (let j = 0; j <= n; j++) {
      if (reach[j] !== true) continue;
      if (part.kind === 'rest') {
        for (let k = j; k <= n; k++) next[k] = true;
        break;
      }
      if (part.optional) next[j] = true;
      const seg = segments[j];
      if (seg !== undefined && (part.kind === 'param' || part.value === seg))
        next[j + 1] = true;
    }
    reach = next;
  }
  return reach[n] === true;
}

/** Specificity of a pattern, higher first: literal segments, then parameters, then no rest part. */
export function specificity(pattern: readonly RouteSegment[]): number[] {
  const count = (k: RouteSegment['kind']): number =>
    pattern.filter((p) => p.kind === k).length;
  return [count('literal'), count('param'), -count('rest')];
}

/**
 * Joins a child pattern to its parent's full path: an absolute child (`/x`) stands alone, a relative one is
 * appended; the result has one leading `/`, no empty segment and no trailing `/`.
 */
export function joinRoute(parent: string | null, child: string): string {
  const raw =
    child.startsWith('/') || parent === null ? child : `${parent}/${child}`;
  const parts = raw.split('/').filter((s) => s !== '');
  return `/${parts.join('/')}`;
}
