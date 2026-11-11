import type { Page, Route } from 'playwright';
import { RunError } from '../../foundation/index.js';
import {
  type ConfirmEntry,
  type CreateConfirm,
  idValues,
  type LedgerFile,
  matchEntry,
  type WireRequest,
} from '../../trust/index.js';
import {
  type CleanupResult,
  type CleanupTarget,
  cleanIds,
  type Leftover,
  type Send,
} from './cleanup.js';
import { sendCreate } from './create.js';
import { MAX_TEXT_BYTES, SeenSet } from './seen.js';

/** The types whose request the ledger authorises; a non-GET of any other type is refused (a form post, a beacon). */
const AUTHORISED_TYPES = new Set(['fetch', 'xhr']);

/** The request types whose URL and body enter the seen-set (those the request layer judges). */
const SCANNED_REQUESTS = new Set([
  'document',
  'fetch',
  'xhr',
  'ping',
  'eventsource',
  'other',
]);

/** What a run gives its ledger. */
export interface LedgerOptions {
  /** The valid `destructiveConfirm` entries for the run's env, flow and current confirmation digest. */
  entries: readonly ConfirmEntry[];
  file: LedgerFile;
  /** The run's `{{uid}}`, once its templates are prepared. */
  uid: () => string | undefined;
  /** Notes a refused request; the request layer ends the run `destructive_blocked` with it. */
  refuse: (method: string, url: string, why: string) => void;
}

/**
 * The run ledger of ADR 0024 section 5 ("The run ledger") and its amendment 2026-11-12 "destructive ledger details":
 * which writes a replay on a `shared` env may send, and which records it created.
 *
 * - A `fetch` or `xhr` request that is not a `GET` is sent only when a stored entry matches it ({@link authorise}):
 *   a `session` entry as is; a `mutate` entry when every id it names was minted by its `ledgerFrom` entry in this
 *   run; a `create` entry when its `nameField` starts with the prefix and holds the run's uid (`create.ts`).
 * - A create's id enters only if no earlier request, response body or page text of the run held it (the seen-set);
 *   its intent and id lines are fsynced before the page sees the answer.
 * - At the end, {@link finish} removes every id, last first, and reports what is left.
 *
 * @remarks A ledger problem (`ledger_replay`, `ledger_mismatch`, `ledger_overflow`) is kept as {@link problem}: the
 *   run ends with it at its next step or check, no write is sent after it, and cleanup still runs.
 */
export class RunLedger {
  /** The run's request counter: `seq` of the ledger lines. */
  seq = 0;
  readonly seen: SeenSet | undefined;
  /** Ids minted in this run, by create entry id. */
  readonly minted = new Map<string, Set<string>>();
  /** Every minted id in order of entry. */
  readonly order: CleanupTarget[] = [];
  /** Creates sent whose answer gave no id and no 4xx yet, by `seq`. */
  readonly open = new Map<number, { entry: string; name: string }>();
  private first: RunError | undefined;
  private readonly pending = new Set<Promise<void>>();

  constructor(readonly o: LedgerOptions) {
    this.seen = o.entries.some((e) => e.kind === 'create')
      ? new SeenSet()
      : undefined;
  }

  /** The first ledger problem of the run, if any. */
  get problem(): RunError | undefined {
    return this.first;
  }

  /** Keeps the first problem; later ones are dropped. */
  fail(e: RunError): void {
    this.first ??= e;
  }

  /** Whether a request of `method` and resource `type` is judged here instead of by the plain replay rule. */
  defers(method: string, type: string): boolean {
    return (
      method.toUpperCase() !== 'GET' && AUTHORISED_TYPES.has(type.toLowerCase())
    );
  }

  /** Adds the URL and body of a request the run sends to the seen-set. */
  scanRequest(url: string, body: Buffer | null, type: string): void {
    if (this.seen === undefined || !SCANNED_REQUESTS.has(type.toLowerCase()))
      return;
    this.guarded(() => {
      this.seen?.add(url, 'a request URL');
      if (body !== null)
        this.seen?.add(body.toString('utf8'), 'a request body');
    });
  }

  /** Scans a response body before the page sees it (`ScanBody` of the redirect hold); never rejects. */
  scanResponse = (
    length: number | undefined,
    read: () => Promise<string>,
  ): Promise<void> => {
    if (this.seen === undefined) return Promise.resolve();
    const p = (async (): Promise<void> => {
      if (length !== undefined)
        this.guarded(() => this.seen?.fits(length, 'a response body'));
      if (this.first?.kind === 'ledger_overflow') return;
      const text = await read().catch(() => '');
      this.guarded(() => this.seen?.add(text, 'a response body'));
    })();
    this.pending.add(p);
    void p.finally(() => this.pending.delete(p));
    return p;
  };

  /** Scans the text of every frame of `page`, then waits for every response scan in flight. */
  async scanPage(page: Page | undefined): Promise<void> {
    if (this.seen === undefined) return;
    for (const f of page?.frames() ?? []) {
      const text = await f
        .evaluate(() => document.body?.innerText ?? '')
        .catch(() => '');
      this.guarded(() => this.seen?.add(text, 'the page text', MAX_TEXT_BYTES));
    }
    await Promise.allSettled([...this.pending]);
  }

  /** Adds the tokens of `text` to the seen-set; an overflow becomes the run's problem. */
  see(text: string, what: string): void {
    this.guarded(() => this.seen?.add(text, what));
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (e) {
      if (e instanceof RunError) this.fail(e);
      else throw e;
    }
  }

  /**
   * Sends `route`'s request when an entry authorises it, else aborts it and notes why.
   *
   * @param page the page that sent it (its frames' text enters the seen-set before a create).
   */
  async authorise(route: Route, page: Page | undefined): Promise<void> {
    const r = route.request();
    const req: WireRequest = {
      method: r.method().toUpperCase(),
      url: r.url(),
      headers: await r.allHeaders(),
      body: r.postDataBuffer(),
    };
    if (this.first !== undefined) {
      this.o.refuse(
        req.method,
        req.url,
        `the run already stopped with ${this.first.kind}`,
      );
      return route.abort('blockedbyclient');
    }
    const m = matchEntry(req, this.o.entries);
    if (typeof m === 'string') {
      this.o.refuse(req.method, req.url, m);
      return route.abort('blockedbyclient');
    }
    if (m.entry.kind === 'session') return route.continue();
    if (m.entry.kind === 'create') return sendCreate(this, route, page, m, req);
    const ids = idValues(m);
    const mine = this.minted.get(m.entry.ledgerFrom);
    const foreign =
      typeof ids === 'string' ? ids : ids.find((id) => mine?.has(id) !== true);
    if (foreign !== undefined) {
      this.o.refuse(
        req.method,
        req.url,
        typeof ids === 'string'
          ? `entry ${m.entry.id}: ${ids}`
          : `entry ${m.entry.id} changes only records this run created through ${m.entry.ledgerFrom}, and id ${foreign} is not one of them`,
      );
      return route.abort('blockedbyclient');
    }
    return route.continue();
  }

  /**
   * Ends the ledger: removes every minted id through its create entry's `cleanup` (`cleanup.ts`), appends a
   * `cleanup` line per id and, after a ledger problem, the `abort` line last, then closes the file.
   *
   * @param send sends a cleanup or verify request with the run's session.
   */
  async finish(send: Send): Promise<CleanupResult> {
    await Promise.allSettled([...this.pending]);
    const names = new Map<number, string>();
    const unconfirmed: Leftover[] = [];
    for (const [seq, i] of this.open) {
      names.set(seq, i.name);
      unconfirmed.push({
        entry: i.entry,
        id: null,
        name: i.name,
        detail: 'create_unconfirmed',
      });
    }
    try {
      const done = await cleanIds(this.order, send, (t, result) =>
        this.o.file.append({
          kind: 'cleanup',
          seq: t.seq,
          entry: t.entry.id,
          id: t.id,
          result,
        }),
      );
      if (this.first !== undefined)
        this.o.file.append({ kind: 'abort', reason: this.first.kind });
      return {
        confirmed: done.confirmed,
        leftover: [...unconfirmed, ...done.leftover],
      };
    } finally {
      this.o.file.close();
    }
  }

  /** Records a minted id: the `id` line, fsynced, then the in-memory sets. */
  mint(entry: CreateConfirm, seq: number, id: string): void {
    this.o.file.append({ kind: 'id', seq, entry: entry.id, id });
    this.open.delete(seq);
    const set = this.minted.get(entry.id) ?? new Set<string>();
    set.add(id);
    this.minted.set(entry.id, set);
    this.order.push({ entry, id, seq });
  }
}
