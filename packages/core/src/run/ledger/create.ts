import type { APIResponse, Page, Route } from 'playwright';
import { RunError } from '../../foundation/index.js';
import { type Matched, stringAt, type WireRequest } from '../../trust/index.js';
import { idOf, valueAt } from './id-of.js';
import type { RunLedger } from './run-ledger.js';
import { idTokens, MAX_BODY_BYTES, MAX_IDS } from './seen.js';

/**
 * Sends a request a `create` entry matched (ADR 0024 section 5, ledger rules 2, 3 and 9): checks the name rules,
 * scans the text of every open page of the run (`pages`: every page of every context), appends the intent line,
 * sends the request from the route, and records the id of a 201 before the answer is handed to the page.
 *
 * @remarks The request is sent with Playwright's `route.fetch` without following redirects, so the answer is read
 *   before the page sees it; a redirect answer is refused (`ledger_mismatch`). A 4xx writes a `none` line; no answer
 *   or another status leaves the intent unconfirmed (reported by cleanup with its name). A 201 whose id was seen
 *   earlier, or is in the request, is `ledger_replay` and is not recorded; one whose natural-key echo differs is
 *   `ledger_mismatch` after its id was recorded, so cleanup removes it. "Seen earlier" is judged once every response
 *   scan in flight has finished (`seenBefore`), so a body still being read cannot hide an id. An answer that comes
 *   after the run's wait for writes in flight is not recorded (`assertOpen`, `record` throw `closed`); a page that
 *   closed before its answer is handed on is not a ledger problem. The fetched answer is disposed once it was handed
 *   on or refused.
 */
export async function sendCreate(
  ledger: RunLedger,
  route: Route,
  pages: () => readonly Page[],
  m: Matched,
  req: WireRequest,
): Promise<void> {
  const abort = (): Promise<void> =>
    route.abort('blockedbyclient').catch(() => undefined);
  const hand = (o: Parameters<Route['fulfill']>[0]): Promise<void> =>
    route.fulfill(o).catch(() => undefined);
  if (m.entry.kind !== 'create') return abort();
  const e = m.entry;
  const name = stringAt(m.leaves, e.nameField);
  const uid = ledger.o.uid();
  const refuse = (why: string): Promise<void> => {
    ledger.o.refuse(req.method, req.url, `entry ${e.id}: ${why}`);
    return abort();
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
    return abort();
  };
  const seq = ++ledger.seq;
  if (ledger.order.length >= MAX_IDS)
    return fail(
      'ledger_overflow',
      seq,
      `the ledger holds ${MAX_IDS} ids (detail ids)`,
    );
  await ledger.scanPages(pages());
  if (ledger.problem !== undefined) return abort();
  ledger.record({ kind: 'intent', seq, entry: e.id, name });
  ledger.open.set(seq, { entry: e.id, name });
  let answer: APIResponse;
  try {
    answer = await route.fetch({ maxRedirects: 0 });
  } catch {
    return route.abort('failed').catch(() => undefined);
  }
  try {
    ledger.assertOpen();
    const status = answer.status();
    if (status >= 400 && status < 500) {
      ledger.record({ kind: 'none', seq, status });
      ledger.open.delete(seq);
      return await hand({ response: answer });
    }
    if (status >= 300 && status < 400)
      return await fail(
        'ledger_mismatch',
        seq,
        `the create answered ${status}, a redirect`,
      );
    if (status !== 201) return await hand({ response: answer });
    const body = await answer.body();
    if (body.length > MAX_BODY_BYTES)
      return await fail(
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
    const id = idOf(e, answer.headersArray(), json, req.url);
    if (typeof id !== 'string')
      return await fail('ledger_mismatch', seq, id.why);
    const inRequest = [
      req.url,
      ...Object.values(req.headers),
      req.body?.toString('utf8') ?? '',
    ].some((s) => idTokens(s).includes(id));
    if (inRequest || (await ledger.seenBefore(id)))
      return await fail(
        'ledger_replay',
        seq,
        `the created id ${id} appeared earlier in the run`,
      );
    ledger.mint(e, seq, id);
    ledger.see(text, 'the create answer');
    for (const k of e.naturalKeys) {
      const echoed = valueAt(json, k);
      if (echoed !== undefined && echoed !== stringAt(m.leaves, k))
        return await fail(
          'ledger_mismatch',
          seq,
          `the answer's ${k} differs from the one sent`,
        );
    }
    return await hand({ response: answer, body });
  } finally {
    await answer.dispose().catch(() => undefined);
  }
}
