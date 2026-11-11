import { leavesOf, readBody } from './body.js';
import { literalPrefix, parseTemplate } from './grammar.js';
import type { ConfirmEntry } from './schema.js';

/** One entry of a run's `network.json`, the part a confirmation reads. */
export interface RecordedCall {
  method: string;
  url: string;
  status: number;
  requestBody?: unknown;
  note?: string;
}

/** A write a recorded run sent, as an entry would name it. */
export interface RecordedWrite {
  method: string;
  template: string;
  contentType: 'json' | 'urlencoded' | undefined;
  bodyKeys: string[];
  queryKeys: string[];
  /** The statuses it was answered with, in order. */
  statuses: number[];
  /** How many `{int}` or `{uuid}` placeholders the template has. */
  placeholders: number;
}

const INT = /^(0|[1-9][0-9]{0,17})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FORM = /^[^=&]+=[^&]*(&[^=&]+=[^&]*)*$/;

/** The template of a recorded path: each canonical int or lowercase uuid segment becomes its placeholder. */
function templateOf(path: string): string | { why: string } {
  const segs = path
    .slice(1)
    .split('/')
    .map((s) => (INT.test(s) ? '{int}' : UUID.test(s) ? '{uuid}' : s));
  const t = `/${segs.join('/')}`;
  const parsed = parseTemplate(t);
  return typeof parsed === 'string' ? { why: parsed } : t;
}

/** The content type and body keys of a recorded body, which `network.json` keeps parsed (JSON) or as text. */
function bodyOf(
  body: unknown,
):
  | { contentType: RecordedWrite['contentType']; keys: string[] }
  | { why: string } {
  if (body === undefined || body === null || body === '')
    return { contentType: undefined, keys: [] };
  if (typeof body === 'string') {
    if (!FORM.test(body))
      return { why: 'a body that is neither JSON nor a form' };
    const leaves = readBody(
      Buffer.from(body),
      'application/x-www-form-urlencoded',
      'urlencoded',
    );
    return typeof leaves === 'string'
      ? { why: leaves }
      : { contentType: 'urlencoded', keys: leaves.map((l) => l.general) };
  }
  const leaves = leavesOf(body);
  return typeof leaves === 'string'
    ? { why: leaves }
    : { contentType: 'json', keys: leaves.map((l) => l.general) };
}

/**
 * The writes a recorded run of a flow sent to `origin` (ADR 0024 section 5, "What the owner sees when confirming";
 * amendment 2026-11-13): each request that is not a `GET`, `HEAD` or `OPTIONS`, with its method, URL template (ids
 * replaced by `{int}` or `{uuid}`), content type, body key pointers and query names, merged per method and template.
 *
 * @returns the writes, and the requests that cannot become an entry, each with why (shown to the owner).
 */
export function recordedWrites(
  calls: readonly RecordedCall[],
  origin: string,
): { writes: RecordedWrite[]; skipped: { request: string; why: string }[] } {
  const writes: RecordedWrite[] = [];
  const skipped: { request: string; why: string }[] = [];
  for (const c of calls) {
    const method = c.method.toUpperCase();
    if (c.note !== undefined || ['GET', 'HEAD', 'OPTIONS'].includes(method))
      continue;
    let url: URL;
    try {
      url = new URL(c.url);
    } catch {
      continue;
    }
    const request = `${method} ${url.pathname}`;
    if (url.origin !== origin) {
      skipped.push({
        request,
        why: `sent to ${url.origin}, not the env's origin`,
      });
      continue;
    }
    const template = templateOf(url.pathname);
    const body = bodyOf(c.requestBody);
    if (typeof template !== 'string' || 'why' in body) {
      skipped.push({
        request,
        why:
          typeof template !== 'string'
            ? template.why
            : 'why' in body
              ? body.why
              : '',
      });
      continue;
    }
    const queryKeys = [...new Set(url.searchParams.keys())];
    const known = writes.find(
      (w) => w.method === method && w.template === template,
    );
    if (known !== undefined) {
      known.bodyKeys = [...new Set([...known.bodyKeys, ...body.keys])];
      known.queryKeys = [...new Set([...known.queryKeys, ...queryKeys])];
      known.statuses.push(c.status);
      continue;
    }
    const t = parseTemplate(template);
    writes.push({
      method,
      template,
      contentType: body.contentType,
      bodyKeys: [...new Set(body.keys)],
      queryKeys,
      statuses: [c.status],
      placeholders:
        typeof t === 'string' ? 0 : t.filter((s) => 'placeholder' in s).length,
    });
  }
  return { writes, skipped };
}

/** What the owner attests for one recorded write, with the default flowctl proposes for each answer. */
export interface Draft {
  write: RecordedWrite;
  kind: 'create' | 'mutate' | 'skip';
  id: string;
  /** create */
  nameField: string;
  naturalKeys: string[];
  conflictStatus: (409 | 422)[];
  idFrom: string;
  cleanup: string;
  verify: string;
  /** mutate */
  ledgerFrom: string;
  idPositions: string[];
}

const prefixOf = (template: string): string => {
  const t = parseTemplate(template);
  return typeof t === 'string' ? template : literalPrefix(t).join('/');
};

/**
 * The defaults flowctl proposes for each write (the owner accepts or changes each at a prompt): a `POST` without a
 * placeholder answered 201 is a `create`, with `nameField` the first body key that names a name, the natural key that
 * field, conflict status 409, `idFrom: body:/id` (the evidence keeps no 2xx body), and cleanup and verify on the
 * template of a recorded write under the same path with one placeholder, else `<template>/{int}`; a `PATCH`, `PUT` or
 * `DELETE` with a placeholder is a `mutate` of the create with the same literal prefix, its id in the path. Anything
 * else is skipped (no entry kind exists for it).
 */
export function proposeDrafts(
  writes: readonly RecordedWrite[],
  flow: string,
): Draft[] {
  const used = new Set<string>();
  const idFor = (kind: string): string => {
    let id = `${flow}-${kind}`;
    for (let n = 2; used.has(id); n++) id = `${flow}-${kind}-${n}`;
    used.add(id);
    return id;
  };
  const drafts = writes.map((w): Draft => {
    const create =
      w.method === 'POST' && w.placeholders === 0 && w.statuses.includes(201);
    const mutate =
      ['PATCH', 'PUT', 'DELETE'].includes(w.method) && w.placeholders > 0;
    const kind = create ? 'create' : mutate ? 'mutate' : 'skip';
    const nameField =
      w.bodyKeys.find((k) => /name|ten/i.test(k)) ?? w.bodyKeys[0] ?? '/name';
    const under = writes.find(
      (o) =>
        o.placeholders === 1 &&
        o.template.startsWith(`${w.template}/`) &&
        prefixOf(o.template) === prefixOf(w.template),
    );
    const cleanup = under?.template ?? `${w.template}/{int}`;
    return {
      write: w,
      kind,
      id: idFor(kind === 'create' ? 'create' : w.method.toLowerCase()),
      nameField,
      naturalKeys: [nameField],
      conflictStatus: [409],
      idFrom: 'body:/id',
      cleanup,
      verify: cleanup,
      ledgerFrom: '',
      idPositions: w.placeholders > 0 ? ['path'] : [],
    };
  });
  for (const d of drafts)
    if (d.kind === 'mutate')
      d.ledgerFrom =
        drafts.find(
          (c) =>
            c.kind === 'create' &&
            prefixOf(c.write.template) === prefixOf(d.write.template),
        )?.id ?? '';
  return drafts;
}

/** What every entry of one confirmation shares. */
export interface EntryBase {
  env: string;
  origin: string;
  expires: string;
  flow: string;
  hash: string;
}

/** The entry an answered draft becomes, or `undefined` for a skipped one. */
export function entryOf(d: Draft, base: EntryBase): ConfirmEntry | undefined {
  const w = d.write;
  const common = {
    ...base,
    id: d.id,
    template: w.template,
    bodyKeys: w.bodyKeys,
    queryKeys: w.queryKeys,
    ...(w.contentType === undefined ? {} : { contentType: w.contentType }),
  };
  if (d.kind === 'create')
    return {
      ...common,
      kind: 'create',
      method: 'POST',
      idFrom: d.idFrom,
      nameField: d.nameField,
      prefix: 'QA-',
      naturalKeys: d.naturalKeys,
      conflictStatus: d.conflictStatus,
      cleanup: {
        method: 'DELETE',
        template: d.cleanup,
        verify: { template: d.verify },
      },
    };
  if (
    d.kind === 'mutate' &&
    (w.method === 'PATCH' || w.method === 'PUT' || w.method === 'DELETE')
  )
    return {
      ...common,
      kind: 'mutate',
      method: w.method,
      ledgerFrom: d.ledgerFrom,
      idPositions: d.idPositions,
    };
  return undefined;
}
