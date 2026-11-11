import { type Leaf, readBody } from './body.js';
import { parseIdPosition, parseTemplate, type Segment } from './grammar.js';
import type { ConfirmEntry } from './schema.js';

/** A request as it is about to leave the browser. */
export interface WireRequest {
  method: string;
  url: string;
  /** Every header, names in any case. */
  headers: Readonly<Record<string, string>>;
  body: Buffer | null;
}

/** A request an entry matched: the entry, the id values of its path placeholders, its body leaves and query. */
export interface Matched {
  entry: ConfirmEntry;
  pathIds: string[];
  leaves: Leaf[];
  query: URLSearchParams;
}

/** The exact header names of ADR 0024 section 2a rule 5, which every request may carry. */
const BASELINE = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'cookie',
  'dnt',
  'host',
  'if-modified-since',
  'if-none-match',
  'origin',
  'pragma',
  'priority',
  'range',
  'referer',
  'upgrade-insecure-requests',
  'user-agent',
]);

const INT = /^(0|[1-9][0-9]{0,17})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The most ids one bulk position may carry (ledger rule 7). */
export const MAX_BULK = 20;

/** The placeholder values of `path` against `segments`, or `undefined` when it does not match exactly. */
function matchPath(
  path: string,
  segments: readonly Segment[],
): string[] | undefined {
  const parts = path.slice(1).split('/');
  if (!path.startsWith('/') || parts.length !== segments.length)
    return undefined;
  const ids: string[] = [];
  for (const [i, s] of segments.entries()) {
    const p = parts[i] ?? '';
    if ('literal' in s) {
      if (p !== s.literal) return undefined;
    } else if (s.placeholder === '{int}' ? INT.test(p) : UUID.test(p))
      ids.push(p);
    else return undefined;
  }
  return ids;
}

/**
 * The placeholder values of `path` against the destructive `template`, with the exact matcher every entry is matched
 * by: literal segments equal, each placeholder value canonical and of its type (`{int}` an int without leading
 * zeros, `{uuid}` a lowercase uuid), no decoding.
 *
 * @returns the values in order, or `undefined` when the template does not parse or the path does not match it.
 */
export function templateIds(
  path: string,
  template: string,
): string[] | undefined {
  const t = parseTemplate(template);
  return typeof t === 'string' ? undefined : matchPath(path, t);
}

/**
 * Why the headers of a request break the entry's header rule, or `undefined`: the baseline names, the `sec-fetch-*`
 * and `sec-ch-ua*` families, `content-type` and `content-length` with a body, and the entry's `headers`; `host` and
 * `origin`, when present, name the entry's origin. A pseudo-header or any other name blocks the request.
 */
function headerProblem(
  req: WireRequest,
  entry: ConfirmEntry,
  hasBody: boolean,
): string | undefined {
  const origin = new URL(entry.origin);
  const extra = new Set(entry.headers ?? []);
  for (const [raw, value] of Object.entries(req.headers)) {
    const h = raw.toLowerCase();
    if (h === 'host' && value.toLowerCase() !== origin.host.toLowerCase())
      return `the Host header ${value.slice(0, 60)}`;
    if (h === 'origin' && value !== entry.origin)
      return `the Origin header ${value.slice(0, 60)}`;
    const ok =
      BASELINE.has(h) ||
      h.startsWith('sec-fetch-') ||
      h.startsWith('sec-ch-ua') ||
      extra.has(h) ||
      (hasBody && (h === 'content-type' || h === 'content-length'));
    if (!ok) return `the header "${h.slice(0, 40)}" is not listed`;
  }
  return undefined;
}

/** Why `req` does not match `entry`, or the match. */
function matchOne(
  req: WireRequest,
  entry: ConfirmEntry,
  url: URL,
  segments: readonly Segment[],
): Matched | string {
  const pathIds = matchPath(url.pathname, segments);
  if (pathIds === undefined) return 'path';
  const names = [...url.searchParams.keys()];
  if (url.search === '' && req.url.split('#')[0]?.includes('?') === true)
    return 'an empty query string';
  for (const n of names)
    if (!entry.queryKeys.includes(n))
      return `the query name "${n.slice(0, 40)}" is not listed`;
  if (new Set(names).size !== names.length) return 'a query name appears twice';
  const contentType = Object.entries(req.headers).find(
    ([k]) => k.toLowerCase() === 'content-type',
  )?.[1];
  const leaves = readBody(req.body, contentType, entry.contentType);
  if (typeof leaves === 'string') return leaves;
  for (const l of leaves)
    if (!entry.bodyKeys.includes(l.general))
      return `the body field ${l.general.slice(0, 60)} is not in bodyKeys`;
  const headers = headerProblem(
    req,
    entry,
    req.body !== null && req.body.length > 0,
  );
  if (headers !== undefined) return headers;
  return { entry, pathIds, leaves, query: url.searchParams };
}

/**
 * The entry among `entries` that authorises sending `req`, on its method, origin, exact template, query names, body
 * discipline and headers (ADR 0024 section 5, ledger rules 4 and 6); ids and names are judged by the run ledger.
 *
 * @remarks The path is matched as sent, without decoding: a placeholder value must already be canonical (an int
 *   without leading zeros, a lowercase uuid), and a percent escape never matches a literal segment.
 * @returns the match, or the reason no entry matched (the first failing rule of an entry whose template matched,
 *   else "no entry").
 */
export function matchEntry(
  req: WireRequest,
  entries: readonly ConfirmEntry[],
): Matched | string {
  let url: URL;
  try {
    url = new URL(req.url);
  } catch {
    return 'the URL does not parse';
  }
  let near: string | undefined;
  for (const e of entries) {
    if (e.method !== req.method.toUpperCase() || e.origin !== url.origin)
      continue;
    const t = parseTemplate(e.template);
    if (typeof t === 'string') continue;
    const m = matchOne(req, e, url, t);
    if (typeof m !== 'string') return m;
    if (m !== 'path') near ??= `entry ${e.id}: ${m}`;
  }
  return near ?? 'no destructiveConfirm entry names this method and path';
}

/** An id value read from a body or query: an int or uuid string, or a safe non-negative integer, canonical. */
export function canonicalId(v: unknown): string | undefined {
  if (typeof v === 'number')
    return Number.isSafeInteger(v) && v >= 0 ? String(v) : undefined;
  if (typeof v !== 'string') return undefined;
  if (INT.test(v)) return v;
  const lower = v.toLowerCase();
  return UUID.test(lower) ? lower : undefined;
}

/**
 * The id values at the `idPositions` of a matched `mutate` request (ledger rule 7): the path placeholders, each
 * `body:` pointer (`/ids/*` gives every element, at most {@link MAX_BULK}) and each `query:` name.
 *
 * @returns the ids, or why the request cannot be authorised (a position without a value, a value that is not an id).
 */
export function idValues(m: Matched): string[] | string {
  if (m.entry.kind !== 'mutate') return [];
  const out: string[] = [...m.pathIds];
  for (const raw of m.entry.idPositions) {
    const p = parseIdPosition(raw);
    if (typeof p === 'string') return p;
    if (p.at === 'path') continue;
    const values =
      p.at === 'query'
        ? m.query.getAll(p.name)
        : m.leaves
            .filter((l) => l.general === p.pointer || l.pointer === p.pointer)
            .map((l) => l.value);
    if (values.length === 0) return `no id at ${raw}`;
    if (values.length > MAX_BULK) return `more than ${MAX_BULK} ids at ${raw}`;
    for (const v of values) {
      const id = canonicalId(v);
      if (id === undefined) return `the value at ${raw} is not an id`;
      out.push(id);
    }
  }
  return out.length === 0 ? 'no id position holds an id' : out;
}

/** The string at `pointer` among `leaves`, or `undefined` when it is absent or not a string. */
export function stringAt(
  leaves: readonly Leaf[],
  pointer: string,
): string | undefined {
  const v = leaves.find((l) => l.pointer === pointer)?.value;
  return typeof v === 'string' ? v : undefined;
}
