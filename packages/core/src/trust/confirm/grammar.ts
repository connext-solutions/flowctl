/**
 * The grammar pieces of a `destructiveConfirm` entry (ADR 0024 section 5 and its amendment 2026-11-12 "destructive
 * ledger details"): URL templates, JSON Pointers and `idPositions`. Pure functions: each returns the first problem as
 * a sentence, or `undefined`.
 *
 * @see docs/adr/0024-target-scope-and-guards.md
 */

/** A literal path segment (amendment 2026-11-12, read-only replay grammar, section 2). */
const LITERAL = /^[A-Za-z0-9._~-]{1,128}$/;

/** The placeholders a destructive template may use: `{slug}` is invalid there (ledger rule 6). */
export const PLACEHOLDERS = ['{int}', '{uuid}'] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** One parsed template segment. */
export type Segment = { literal: string } | { placeholder: Placeholder };

const isPlaceholder = (s: string): s is Placeholder =>
  s === '{int}' || s === '{uuid}';

/**
 * Parses a destructive URL template: `/` then segments, each a literal or exactly `{int}` or `{uuid}`; at most 2048
 * bytes and 32 segments; the first segment literal; no empty, `.` or `..` segment; no `*`, regex, optional segment or
 * trailing `/`.
 *
 * @remarks Unlike a production read-only template, a destructive template may end with a placeholder
 *   (`/api/items/{int}` is the shape of every `mutate` entry); see the ADR 0024 amendment 2026-11-13. A trailing `/`
 *   is refused, which is stricter than the read-only grammar.
 * @returns the segments, or the problem.
 */
export function parseTemplate(t: string): Segment[] | string {
  if (!t.startsWith('/')) return 'a template starts with /';
  if (Buffer.byteLength(t) > 2048) return 'a template has at most 2048 bytes';
  const parts = t.slice(1).split('/');
  if (parts.length > 32) return 'a template has at most 32 segments';
  const out: Segment[] = [];
  for (const p of parts) {
    if (isPlaceholder(p)) out.push({ placeholder: p });
    else if (LITERAL.test(p) && p !== '.' && p !== '..')
      out.push({ literal: p });
    else
      return `the segment "${p.slice(0, 40)}" is neither a literal nor {int} or {uuid}`;
  }
  if (out[0] === undefined || !('literal' in out[0]))
    return 'the first segment of a template is literal';
  return out;
}

/** The literal segments before the first placeholder (the "literal path prefix" of the prefix rule). */
export function literalPrefix(segments: readonly Segment[]): string[] {
  const out: string[] = [];
  for (const s of segments) {
    if (!('literal' in s)) break;
    out.push(s.literal);
  }
  return out;
}

/** The number of placeholders in a template. */
export const placeholders = (segments: readonly Segment[]): number =>
  segments.filter((s) => 'placeholder' in s).length;

/**
 * Parses a JSON Pointer (RFC 6901) of an entry: `/a/b`, escapes `~0` and `~1` only; a segment `*` stands for every
 * index of an array; `-` is refused. An empty pointer (the whole body) is refused.
 *
 * @param single the body is `urlencoded`: exactly one segment, the field name.
 * @param noWildcard refuse `*` (an `idFrom` or `nameField` names one value).
 * @returns the decoded segments, or the problem.
 */
export function parsePointer(
  p: string,
  o: { single?: boolean; noWildcard?: boolean } = {},
): string[] | string {
  if (!p.startsWith('/')) return `"${p.slice(0, 40)}" is not a JSON Pointer`;
  const raw = p.slice(1).split('/');
  const out: string[] = [];
  for (const r of raw) {
    if (/~(?![01])/.test(r)) return `"${p.slice(0, 40)}" has a bad ~ escape`;
    const seg = r.replace(/~1/g, '/').replace(/~0/g, '~');
    if (seg === '-') return 'the pointer segment "-" is refused';
    if (seg === '*' && o.noWildcard === true)
      return `"${p.slice(0, 40)}" must name one value, without *`;
    out.push(seg);
  }
  if (o.single === true && out.length !== 1)
    return `"${p.slice(0, 40)}" must have exactly one segment for an urlencoded body`;
  return out;
}

/** One position of a `mutate` entry that carries an id. */
export type IdPosition =
  | { at: 'path' }
  | { at: 'body'; pointer: string }
  | { at: 'query'; name: string };

/** A query or header name of an entry. */
export const QUERY_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

/**
 * Parses one `idPositions` item: `path`, `body:<JSON Pointer>` (an array of ids is `body:/ids/*`) or
 * `query:<name>`.
 */
export function parseIdPosition(s: string): IdPosition | string {
  if (s === 'path') return { at: 'path' };
  if (s.startsWith('body:')) {
    const pointer = s.slice(5);
    const parsed = parsePointer(pointer);
    return typeof parsed === 'string' ? parsed : { at: 'body', pointer };
  }
  if (s.startsWith('query:') && QUERY_NAME.test(s.slice(6)))
    return { at: 'query', name: s.slice(6) };
  return `"${s.slice(0, 40)}" is not path, body:<pointer> or query:<name>`;
}

/** Whether a template path matches a glob-free path exactly (used to test a `session` template against `deny`). */
export const templatePath = (segments: readonly Segment[]): string =>
  `/${segments.map((s) => ('literal' in s ? s.literal : s.placeholder)).join('/')}`;
