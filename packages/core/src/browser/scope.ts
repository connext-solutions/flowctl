import { isPrivateHost } from '../foundation/index.js';

/**
 * What one run may reach (ADR 0024 section 3): the origins a page may be opened on (`visit`) and the origins its
 * requests may go to (`call`), the paths on the env's own origin a page may show (`allow`, empty for any), the paths
 * no request may reach (`deny`), and the production hosts nothing may touch (section 2).
 */
export interface Scope {
  envOrigin: string;
  visit: readonly string[];
  call: readonly string[];
  allow: readonly string[];
  deny: readonly string[];
  productionHosts: readonly string[];
}

/** A page navigation (`visit`) or any other request the page makes (`call`). */
export type ScopeKind = 'visit' | 'call';

/** Whether a URL may be reached, and when not, why (the run reports it as `scope_violation`). */
export type ScopeVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Paths no run may reach whatever the repo says (ADR 0024 section 3: `deny` starts with logout): a run that logs its
 * own profile out loses the session the next runs need. Account deletion and other destructive paths are the request
 * layer's (T1.3).
 */
export const BUILT_IN_DENY: readonly string[] = [
  '/**/logout',
  '/**/logout/**',
  '/**/log-out',
  '/**/logoff',
  '/**/signout',
  '/**/sign-out',
];

/** Rounds of percent-decoding before a path that still changes is refused (rule 3). */
const DECODE_ROUNDS = 5;

const refuse = (reason: string): ScopeVerdict => ({ ok: false, reason });

/**
 * The path `raw` as a server may finally read it (rule 3): percent-decoded to a fixed point (at most
 * {@link DECODE_ROUNDS} rounds), then split into segments with `;params` stripped from each, empty segments dropped
 * (servers merge `//`), and `.` and `..` resolved last, so `..;` and `/%2F%2F` cannot hide a segment.
 *
 * @returns the path, or `undefined` when it never settles, does not decode, or decodes to a character that would
 *   change how it parses (`?`, `#`, a backslash or a control character).
 */
export function normalisePath(raw: string): string | undefined {
  let cur = raw;
  for (let round = 0; ; round++) {
    let next: string;
    try {
      next = decodeURIComponent(cur);
    } catch {
      return undefined;
    }
    if (next === cur) break;
    if (round + 1 >= DECODE_ROUNDS) return undefined;
    cur = next;
  }
  if (
    /[?#\\]/.test(cur) ||
    [...cur].some((c) => (c.codePointAt(0) ?? 0) < 0x20)
  )
    return undefined;
  const out: string[] = [];
  for (const raw of cur.split('/')) {
    const seg = raw.split(';')[0] ?? '';
    if (seg === '' || seg === '.') continue;
    if (seg === '..') out.pop();
    else out.push(seg);
  }
  return `/${out.join('/')}`;
}

const escape = (s: string): string => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/**
 * A path pattern as a regular expression: `*` matches within one segment, a `**` segment matches any number of
 * segments (none included), everything else is literal. A pattern without a leading `/` is read as rooted, so
 * `admin/**` means `/admin/**` and never everything.
 *
 * @example pathGlob('/hrm/**', false).test('/hrm/leave/1') // true
 */
export function pathGlob(pattern: string, caseFold: boolean): RegExp {
  const rooted = pattern.startsWith('/') ? pattern : `/${pattern}`;
  const p = caseFold ? rooted.toLowerCase() : rooted;
  const body = p
    .split('/')
    .slice(1)
    .map((seg) =>
      seg === '**'
        ? '(?:/[^/]*)*'
        : `/${seg.split('*').map(escape).join('[^/]*')}`,
    )
    .join('');
  return new RegExp(`^${body}$`);
}

const matches = (
  path: string,
  patterns: readonly string[],
  caseFold: boolean,
): string | undefined => {
  const p = caseFold ? path.toLowerCase() : path;
  return patterns.find((g) => pathGlob(g, caseFold).test(p));
};

/**
 * Whether `url` may be reached as `kind` in `scope` (ADR 0024 sections 2 and 3). The rules, in order:
 * - only `http` and `https`; `http` only to a loopback or RFC 1918 host; no userinfo;
 * - nothing on a production host (any scheme or port);
 * - a `visit` must be on a `visit` origin; a `call` on a `call` or `visit` origin (a page may load from the origin
 *   it was opened on);
 * - the path, normalised by {@link normalisePath}, must match no `deny` pattern (case-folded) and, for a `visit` on the
 *   env's own origin, an `allow` pattern when there are any (case-sensitive); `deny` wins. A hash route (`#/...`) is
 *   judged the same way, so a single-page app's `#/admin` cannot slip past. Only `#/` is a hash route (ADR 0024
 *   section 3, rule 5); `#!/x` and other fragments are not judged.
 */
export function inScope(
  url: string,
  kind: ScopeKind,
  scope: Scope,
): ScopeVerdict {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return refuse(`${url} is not a URL`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    return refuse(`${u.protocol} URLs are never opened (${url.slice(0, 80)})`);
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname))
    return refuse(
      `plain http to ${u.host} is refused; only https may leave this machine's network`,
    );
  if (u.username !== '' || u.password !== '')
    return refuse(
      `${u.host} is addressed with a user name or password in the URL`,
    );
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (scope.productionHosts.includes(host))
    return refuse(
      `${u.origin} is a production host; runs never reach production (read-only replay is not built yet)`,
    );
  const origins =
    kind === 'visit' ? scope.visit : [...scope.call, ...scope.visit];
  if (!origins.includes(u.origin))
    return refuse(
      kind === 'visit'
        ? `${u.origin} is outside the origins this run may open (${scope.visit.join(', ') || 'none'}). Add it with: flowctl trust add origin <env> visit ${u.origin}`
        : `${u.origin} is outside the origins this run may call (${[...new Set(origins)].join(', ') || 'none'}). Add it with: flowctl trust add origin <env> call ${u.origin}`,
    );
  const paths = [u.pathname];
  if (kind === 'visit' && u.hash.startsWith('#/'))
    paths.push(u.hash.slice(1).split('?')[0] ?? '');
  for (const raw of paths) {
    const path = normalisePath(raw);
    if (path === undefined)
      return refuse(
        `the path ${raw.slice(0, 80)} does not settle when decoded`,
      );
    const denied = matches(path, [...BUILT_IN_DENY, ...scope.deny], true);
    if (denied !== undefined)
      return refuse(`${path} matches the deny pattern ${denied}`);
    if (
      kind === 'visit' &&
      u.origin === scope.envOrigin &&
      scope.allow.length > 0 &&
      matches(path, scope.allow, false) === undefined
    )
      return refuse(
        `${path} matches no target.scope.allow pattern (${scope.allow.join(', ')})`,
      );
  }
  return { ok: true };
}
