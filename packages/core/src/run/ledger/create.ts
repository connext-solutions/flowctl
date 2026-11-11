import type { APIResponse, Page, Route } from 'playwright';
import { RunError } from '../../foundation/index.js';
import {
  canonicalId,
  type CreateConfirm,
  type Matched,
  parsePointer,
  parseTemplate,
  stringAt,
  type WireRequest,
} from '../../trust/index.js';
import type { RunLedger } from './run-ledger.js';
import { idTokens, MAX_BODY_BYTES, MAX_IDS } from './seen.js';

/** The value at a JSON Pointer of `doc`, or `undefined`. */
function valueAt(doc: unknown, pointer: string): unknown {
  const segs = parsePointer(pointer, { noWildcard: true });
  if (typeof segs === 'string') return undefined;
  let at: unknown = doc;
  for (const s of segs) {
    if (Array.isArray(at))
      at = /^(0|[1-9][0-9]*)$/.test(s) ? at[Number(s)] : undefined;
    else if (typeof at === 'object' && at !== null && Object.hasOwn(at, s))
      at = Object.getOwnPropertyDescriptor(at, s)?.value;
    else return undefined;
  }
  return at;
}

/**
 * The id a 201 answer names at the entry's `idFrom` (ADR 0024 amendment 2026-11-12, section 2): a JSON string or
 * number at a `body:` pointer, canonical; or the one placeholder of the `cleanup` template in a single same-origin
 * `Location` header.
 *
 * @returns the id, or why none can be read (the run then ends `ledger_mismatch`).
 */
function idOf(
  e: CreateConfirm,
  answer: APIResponse,
  json: unknown,
  url: string,
): string | { why: string } {
  if (e.idFrom.startsWith('body:')) {
    const v = valueAt(json, e.idFrom.slice(5));
    const id = canonicalId(v);
    return id ?? { why: `the answer holds no int or uuid at ${e.idFrom}` };
  }
  const locations = answer
    .headersArray()
    .filter((h) => h.name.toLowerCase() === 'location');
  const [only] = locations;
  if (locations.length !== 1 || only === undefined)
    return { why: 'the answer does not have exactly one Location header' };
  let loc: URL;
  try {
    loc = new URL(only.value, url);
  } catch {
    return { why: 'the Location header does not parse' };
  }
  const t = parseTemplate(e.cleanup.template);
  if (loc.origin !== e.origin || typeof t === 'string')
    return { why: 'the Location header names another origin' };
  const parts = loc.pathname.slice(1).split('/');
  if (parts.length !== t.length)
    return { why: 'the Location path does not match the cleanup template' };
  let id: string | undefined;
  for (const [i, s] of t.entries()) {
    const p = parts[i] ?? '';
    if ('literal' in s) {
      if (s.literal !== p)
        return { why: 'the Location path does not match the cleanup template' };
    } else id = canonicalId(p) === p ? p : undefined;
  }
  return id ?? { why: 'the Location path holds no canonical id' };
}

/**
 * Sends a request a `create` entry matched (ADR 0024 section 5, ledger rules 2, 3 and 9): checks the name rules,
 * scans the page, appends the intent line, sends the request from the route, and records the id of a 201 before the
 * answer is handed to the page.
 *
 * @remarks The request is sent with Playwright's `route.fetch` without following redirects, so the answer is read
 *   before the page sees it; a redirect answer is refused (`ledger_mismatch`). A 4xx writes a `none` line; no answer
 *   or another status leaves the intent unconfirmed (reported by cleanup with its name). A 201 whose id was seen
 *   earlier, or is in the request, is `ledger_replay` and is not recorded; one whose natural-key echo differs is
 *   `ledger_mismatch` after its id was recorded, so cleanup removes it.
 */
export async function sendCreate(
  ledger: RunLedger,
  route: Route,
  page: Page | undefined,
  m: Matched,
  req: WireRequest,
): Promise<void> {
  if (m.entry.kind !== 'create') return route.abort('blockedbyclient');
  const e = m.entry;
  const name = stringAt(m.leaves, e.nameField);
  const uid = ledger.o.uid();
  const refuse = (why: string): Promise<void> => {
    ledger.o.refuse(req.method, req.url, `entry ${e.id}: ${why}`);
    return route.abort('blockedbyclient');
  };
  if (
    name === undefined ||
    !name.startsWith(e.prefix) ||
    uid === undefined ||
    !name.includes(uid)
  )
    return refuse(
      `the field ${e.nameField} must be a string that starts with ${e.prefix} and holds the run's {{uid}}`,
    );
  for (const k of e.naturalKeys)
    if (!(stringAt(m.leaves, k) ?? '').startsWith(e.prefix))
      return refuse(`the natural key ${k} must start with ${e.prefix}`);
  const fail = (
    kind: 'ledger_replay' | 'ledger_mismatch' | 'ledger_overflow',
    seq: number,
    why: string,
  ): Promise<void> => {
    ledger.fail(
      new RunError(
        kind,
        `${kind}: entry ${e.id}, request ${seq}: ${why}. The run stopped and cleans up what it created.`,
      ),
    );
    return route.abort('blockedbyclient');
  };
  const seq = ++ledger.seq;
  if (ledger.order.length >= MAX_IDS)
    return fail(
      'ledger_overflow',
      seq,
      `the ledger holds ${MAX_IDS} ids (detail ids)`,
    );
  await ledger.scanPage(page);
  if (ledger.problem !== undefined) return route.abort('blockedbyclient');
  ledger.o.file.append({ kind: 'intent', seq, entry: e.id, name });
  ledger.open.set(seq, { entry: e.id, name });
  let answer: APIResponse;
  try {
    answer = await route.fetch({ maxRedirects: 0 });
  } catch {
    return route.abort('failed').catch(() => undefined);
  }
  const status = answer.status();
  if (status >= 400 && status < 500) {
    ledger.o.file.append({ kind: 'none', seq, status });
    ledger.open.delete(seq);
    return route.fulfill({ response: answer });
  }
  if (status >= 300 && status < 400)
    return fail(
      'ledger_mismatch',
      seq,
      `the create answered ${status}, a redirect`,
    );
  if (status !== 201) return route.fulfill({ response: answer });
  const body = await answer.body();
  if (body.length > MAX_BODY_BYTES)
    return fail(
      'ledger_overflow',
      seq,
      'the answer is over 8 MiB (detail body)',
    );
  const text = body.toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const id = idOf(e, answer, json, req.url);
  if (typeof id !== 'string') return fail('ledger_mismatch', seq, id.why);
  const inRequest = [
    req.url,
    ...Object.values(req.headers),
    req.body?.toString('utf8') ?? '',
  ].some((s) => idTokens(s).includes(id));
  if (inRequest || ledger.seen?.has(id) === true)
    return fail(
      'ledger_replay',
      seq,
      `the created id ${id} appeared earlier in the run`,
    );
  ledger.mint(e, seq, id);
  ledger.see(text, 'the create answer');
  for (const k of e.naturalKeys) {
    const echoed = valueAt(json, k);
    if (echoed !== undefined && echoed !== stringAt(m.leaves, k))
      return fail(
        'ledger_mismatch',
        seq,
        `the answer's ${k} differs from the one sent`,
      );
  }
  return route.fulfill({ response: answer, body });
}
