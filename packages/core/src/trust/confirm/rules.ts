import dayjs from 'dayjs';
import {
  literalPrefix,
  parseIdPosition,
  parsePointer,
  parseTemplate,
  placeholders,
  QUERY_NAME,
  type Segment,
  templatePath,
} from './grammar.js';
import type { ConfirmEntry, CreateConfirm } from './schema.js';

/** The longest an entry may stay valid: 90 days after the UTC date it is checked on (ADR 0024 amendment 2026-11-12). */
export const MAX_DAYS = 90;

/** Caps per entry (ADR 0024 amendment 2026-11-13): the ADR names none, so these bound what an owner reviews. */
const CAPS = { bodyKeys: 64, queryKeys: 16, headers: 8 } as const;

/** What the rules need from outside an entry. */
export interface RuleContext {
  /** The store's envs (verified), by name. */
  envs: Readonly<Record<string, { origin: string; class: string }>>;
  /** Now; the UTC date of it is "today". */
  now: Date;
  /** Whether a literal path is denied (the built-in `deny` list and the repo's), for `session` templates. */
  denied: (path: string) => boolean;
}

/** `YYYY-MM-DD` of `d` in UTC. */
export const utcDate = (d: Date | dayjs.Dayjs): string =>
  dayjs(d).toISOString().slice(0, 10);

/** Whether `s` is a real calendar date written `YYYY-MM-DD`. */
export const realDate = (s: string): boolean =>
  /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s) &&
  utcDate(dayjs(`${s}T00:00:00.000Z`)) === s;

/** The last date an entry written or checked `now` may carry as `expires`. */
export const latestExpiry = (now: Date): string =>
  utcDate(dayjs(now).add(MAX_DAYS * 24, 'hour'));

const unique = (xs: readonly (string | number)[]): boolean =>
  new Set(xs).size === xs.length;

/** Whether `pointer` is listed in `bodyKeys` exactly (an array is listed with `*`, as `/ids/*`). */
const listed = (pointer: string, bodyKeys: readonly string[]): boolean =>
  bodyKeys.includes(pointer);

/**
 * The first rule of ADR 0024 section 5 (and its amendments) that `e` breaks on its own, or `undefined`. An expired
 * entry is not broken: the caller treats it as absent.
 */
export function entryProblem(
  e: ConfirmEntry,
  ctx: RuleContext,
): string | undefined {
  const env = Object.hasOwn(ctx.envs, e.env) ? ctx.envs[e.env] : undefined;
  if (env === undefined) return `the store has no env "${e.env}"`;
  if (env.class !== 'shared' && env.class !== 'local')
    return `env "${e.env}" is classed ${env.class}; no confirmation exists there`;
  if (e.origin !== env.origin)
    return `the origin ${e.origin} is not the store's origin of env "${e.env}" (${env.origin}); run flowctl trust add destructive --renew-env ${e.env}`;
  if (!realDate(e.expires)) return `expires ${e.expires} is not a real date`;
  if (e.expires > latestExpiry(ctx.now))
    return `expires ${e.expires} is more than ${MAX_DAYS} days ahead`;
  const t = parseTemplate(e.template);
  if (typeof t === 'string') return t;
  const shape = bodyProblem(e);
  if (shape !== undefined) return shape;
  if (e.kind === 'create') return createProblem(e, t);
  if (e.kind === 'session') {
    if (placeholders(t) > 0) return 'a session template is literal';
    if (ctx.denied(templatePath(t)))
      return `the session template ${e.template} is denied (logout and the deny list win over every entry)`;
    return undefined;
  }
  const n = placeholders(t);
  const positions = e.idPositions.map(parseIdPosition);
  for (const p of positions) {
    if (typeof p === 'string') return p;
    if (p.at === 'body' && !listed(p.pointer, e.bodyKeys))
      return `the id position body:${p.pointer} is not in bodyKeys`;
    if (p.at === 'query' && !e.queryKeys.includes(p.name))
      return `the id position query:${p.name} is not in queryKeys`;
  }
  const hasPath = positions.some(
    (p) => typeof p !== 'string' && p.at === 'path',
  );
  if (n > 0 && !hasPath)
    return 'every placeholder is an id position: list path in idPositions';
  if (n === 0 && hasPath)
    return 'idPositions lists path, but the template has no placeholder';
  if (!unique(e.idPositions)) return 'idPositions lists a position twice';
  return undefined;
}

function bodyProblem(e: ConfirmEntry): string | undefined {
  const needsType = !(e.method === 'DELETE' && e.bodyKeys.length === 0);
  if (needsType && e.contentType === undefined)
    return 'contentType is required unless the entry is a DELETE without a body';
  if (e.bodyKeys.length > CAPS.bodyKeys)
    return `at most ${CAPS.bodyKeys} bodyKeys`;
  if (e.queryKeys.length > CAPS.queryKeys)
    return `at most ${CAPS.queryKeys} queryKeys`;
  if (!unique(e.bodyKeys) || !unique(e.queryKeys))
    return 'a key is listed twice';
  for (const k of e.bodyKeys) {
    const p = parsePointer(k, { single: e.contentType === 'urlencoded' });
    if (typeof p === 'string') return p;
  }
  for (const q of e.queryKeys)
    if (!QUERY_NAME.test(q)) return `"${q.slice(0, 40)}" is not a query name`;
  const headers = e.headers ?? [];
  if (headers.length > CAPS.headers || !unique(headers))
    return `at most ${CAPS.headers} distinct headers`;
  for (const h of headers)
    if (
      !/^[a-z0-9-]+$/.test(h) ||
      h.includes('method') ||
      h.includes('override')
    )
      return `the header "${h.slice(0, 40)}" is refused`;
  return undefined;
}

function createProblem(e: CreateConfirm, t: Segment[]): string | undefined {
  if (placeholders(t) > 0)
    return 'a create template has no placeholder (ADR 0024 amendment 2026-11-13)';
  if (e.bodyKeys.length === 0) return 'a create entry lists its bodyKeys';
  if (!e.prefix.startsWith('QA-'))
    return 'the prefix of a create entry starts with QA-';
  if (e.idFrom !== 'header:Location') {
    if (!e.idFrom.startsWith('body:'))
      return 'idFrom is body:<pointer> or header:Location';
    const p = parsePointer(e.idFrom.slice(5), { noWildcard: true });
    if (typeof p === 'string') return p;
  }
  for (const k of [e.nameField, ...e.naturalKeys]) {
    const p = parsePointer(k, {
      noWildcard: true,
      single: e.contentType === 'urlencoded',
    });
    if (typeof p === 'string') return p;
    if (!listed(k, e.bodyKeys)) return `${k} is not in bodyKeys`;
  }
  if (!unique(e.naturalKeys) || !unique(e.conflictStatus))
    return 'naturalKeys and conflictStatus list each value once';
  const prefix = literalPrefix(t).join('/');
  for (const [what, tpl] of [
    ['cleanup', e.cleanup.template],
    ['verify', e.cleanup.verify.template],
  ] as const) {
    const c = parseTemplate(tpl);
    if (typeof c === 'string') return `${what}: ${c}`;
    if (placeholders(c) !== 1)
      return `the ${what} template has exactly one placeholder, the id`;
    if (literalPrefix(c).join('/') !== prefix)
      return `the ${what} template does not share the literal prefix of ${e.template}`;
  }
  return undefined;
}

/**
 * The rules between entries: ids are unique, and a `mutate` entry's `ledgerFrom` names a valid `create` entry of the
 * same env, origin and flow whose literal path prefix its template shares.
 *
 * @param valid the entries that broke no rule on their own.
 * @returns a problem per entry id; an entry whose `ledgerFrom` is invalid is invalid too.
 */
export function crossProblems(
  valid: readonly ConfirmEntry[],
): Map<string, string> {
  const out = new Map<string, string>();
  const count = new Map<string, number>();
  for (const e of valid) count.set(e.id, (count.get(e.id) ?? 0) + 1);
  for (const e of valid)
    if ((count.get(e.id) ?? 0) > 1)
      out.set(e.id, `the id ${e.id} is used twice`);
  for (const e of valid) {
    if (e.kind !== 'mutate' || out.has(e.id)) continue;
    const c = valid.find((x) => x.id === e.ledgerFrom);
    if (c === undefined || c.kind !== 'create' || out.has(c.id))
      out.set(e.id, `ledgerFrom ${e.ledgerFrom} is not a valid create entry`);
    else if (c.env !== e.env || c.origin !== e.origin || c.flow !== e.flow)
      out.set(
        e.id,
        `ledgerFrom ${e.ledgerFrom} is for another env, origin or flow`,
      );
    else {
      const mine = parseTemplate(e.template);
      const theirs = parseTemplate(c.template);
      if (
        typeof mine === 'string' ||
        typeof theirs === 'string' ||
        literalPrefix(mine).join('/') !== literalPrefix(theirs).join('/')
      )
        out.set(
          e.id,
          `the template does not share the literal prefix of ${c.template}`,
        );
    }
  }
  return out;
}
