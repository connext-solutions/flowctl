import type { Page, Route } from 'playwright';
import { RunError } from '../../foundation/index.js';
import {
  type ConfirmEntry,
  type CreateConfirm,
  idValues,
  type LedgerFile,
  type NewLedgerLine,
  matchEntry,
  TrustError,
  type WireRequest,
} from '../../trust/index.js';
import { errorMessage } from '../outcome.js';
import {
  type CleanupResult,
  type CleanupTarget,
  cleanIds,
  type Leftover,
  type Send,
} from './cleanup.js';
import { sendCreate } from './create.js';
import { LedgerScans } from './scan.js';

/** `p`, without its rejection: a route the page already closed is not a ledger problem. */
const quiet = (p: Promise<void>): Promise<void> => p.catch(() => undefined);

/** The types whose request the ledger authorises; a non-GET of any other type is refused (a form post, a beacon). */
const AUTHORISED_TYPES = new Set(['fetch', 'xhr']);

/**
 * The longest {@link RunLedger.finish} waits for writes still in flight when the run ends; a create not answered by
 * then stays unconfirmed (reported with its name) and its late answer is never recorded.
 */
export const IN_FLIGHT_WAIT_MS = 15_000;

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
export class RunLedger extends LedgerScans {
  /** The run's request counter: `seq` of the ledger lines. */
  seq = 0;
  /** Ids minted in this run, by create entry id. */
  readonly minted = new Map<string, Set<string>>();
  /** Every minted id in order of entry. */
  readonly order: CleanupTarget[] = [];
  /** Creates sent whose answer gave no id and no 4xx yet, by `seq`. */
  readonly open = new Map<number, { entry: string; name: string }>();
  /**
   * The bound {@link finish} waits by, {@link IN_FLIGHT_WAIT_MS}; a test seam (a test lowers it to reach the end of the
   * wait in time), never changed by production code.
   */
  static waitMs = IN_FLIGHT_WAIT_MS;
  private readonly inFlight = new Set<Promise<void>>();
  private closing = false;
  /** Set once the wait for writes in flight ended: a create answered later records nothing ({@link record}). */
  private sealed = false;

  constructor(readonly o: LedgerOptions) {
    super(o.entries.some((e) => e.kind === 'create'));
  }

  /** Whether a request of `method` and resource `type` is judged here instead of by the plain replay rule. */
  defers(method: string, type: string): boolean {
    return (
      method.toUpperCase() !== 'GET' && AUTHORISED_TYPES.has(type.toLowerCase())
    );
  }

  /**
   * Sends `route`'s request when an entry authorises it, else aborts it and notes why.
   *
   * @remarks Once {@link finish} started, every write is refused (`closing` is set before anything else), and every
   *   call that started before is tracked until it ends, so {@link finish} can wait for it before it copies the ids. A
   *   create answered after the bounded wait is refused by the ledger ({@link record}, detail `closed`) and aborted;
   *   its intent stays unconfirmed. Any other failure (a ledger line that cannot be written, a request that cannot be
   *   read) aborts the request and becomes the run's problem, `internal`, so the run never ends `failed` on it.
   * @param page the page that sent it (its frames' text enters the seen-set before a create).
   */
  authorise(route: Route, page: Page | undefined): Promise<void> {
    if (this.closing) {
      const r = route.request();
      this.o.refuse(r.method(), r.url(), 'the run was ending');
      return quiet(route.abort('blockedbyclient'));
    }
    const p = this.judge(route, page).catch((e: unknown) => {
      if (!(e instanceof TrustError && e.detail === 'closed'))
        this.fail(
          new RunError(
            'internal',
            `The run ledger could not judge or record a write, so it was not sent: ${errorMessage(e)}`,
          ),
        );
      return quiet(route.abort('failed'));
    });
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p)).catch(() => undefined);
    return p;
  }

  private async judge(route: Route, page: Page | undefined): Promise<void> {
    const r = route.request();
    const req: WireRequest = {
      method: r.method().toUpperCase(),
      url: r.url(),
      headers: await r.allHeaders(),
      body: r.postDataBuffer(),
    };
    if (this.problem !== undefined) {
      this.o.refuse(
        req.method,
        req.url,
        `the run already stopped with ${this.problem.kind}`,
      );
      return quiet(route.abort('blockedbyclient'));
    }
    const m = matchEntry(req, this.o.entries);
    if (typeof m === 'string') {
      this.o.refuse(req.method, req.url, m);
      return quiet(route.abort('blockedbyclient'));
    }
    if (m.entry.kind === 'session') return quiet(route.continue());
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
      return quiet(route.abort('blockedbyclient'));
    }
    return quiet(route.continue());
  }

  /**
   * Ends the ledger: refuses every new write, waits (at most {@link IN_FLIGHT_WAIT_MS}) for the writes in flight and
   * the response scans, then removes every minted id through its create entry's `cleanup` (`cleanup.ts`), appends a
   * `cleanup` line per id and, after a ledger problem, the `abort` line last, then closes the file.
   *
   * @remarks Once the wait ended, the ledger is sealed: a create answered later appends nothing ({@link record}), so
   *   no id enters after the ids were copied and the `abort` line stays last. A line that cannot be written at the end
   *   does not stop the cleanup; it becomes the run's problem, `internal`.
   * @param send sends a cleanup or verify request with the run's session.
   * @param waitMs the bound on the wait for writes in flight.
   */
  async finish(
    send: Send,
    waitMs: number = RunLedger.waitMs,
  ): Promise<CleanupResult> {
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(this.inFlight),
      new Promise((resolve) => (timer = setTimeout(resolve, waitMs))),
    ]);
    clearTimeout(timer);
    this.sealed = true;
    await this.settle();
    const unconfirmed: Leftover[] = [];
    for (const i of this.open.values()) {
      unconfirmed.push({
        entry: i.entry,
        id: null,
        name: i.name,
        detail: 'create_unconfirmed',
      });
    }
    try {
      const done = await cleanIds([...this.order], send, (t, result) =>
        this.closingLine({
          kind: 'cleanup',
          seq: t.seq,
          entry: t.entry.id,
          id: t.id,
          result,
        }),
      );
      if (this.problem !== undefined)
        this.closingLine({ kind: 'abort', reason: this.problem.kind });
      return {
        confirmed: done.confirmed,
        leftover: [...unconfirmed, ...done.leftover],
      };
    } finally {
      this.o.file.close();
    }
  }

  /**
   * Records a minted id: the `id` line, fsynced, then the in-memory sets, the seen-set included, so a second 201 with
   * the same id is `ledger_replay` whatever `idFrom` read it from (a `Location` header puts it in no body).
   *
   * @throws {TrustError} `ledgers_invalid` `closed` once the wait for writes in flight ended.
   */
  mint(entry: CreateConfirm, seq: number, id: string): void {
    this.record({ kind: 'id', seq, entry: entry.id, id });
    this.see(id, 'a created id');
    this.open.delete(seq);
    const set = this.minted.get(entry.id) ?? new Set<string>();
    set.add(id);
    this.minted.set(entry.id, set);
    this.order.push({ entry, id, seq });
  }

  /**
   * Appends a line of a request in flight (`intent`, `id`, `none`).
   *
   * @throws {TrustError} `ledgers_invalid` `closed` once the wait for writes in flight ended (ADR 0024 amendment
   *   2026-11-13: a create answered later is never recorded); `write_failed` from the file.
   */
  record(line: NewLedgerLine): void {
    this.assertOpen();
    this.o.file.append(line);
  }

  /** @throws {TrustError} `ledgers_invalid` `closed` once the wait for writes in flight ended. */
  assertOpen(): void {
    if (this.sealed)
      throw new TrustError(
        'ledgers_invalid',
        `The run ledger ${this.o.file.path} stopped taking writes at the end of the run; this answer is not recorded.`,
        'closed',
      );
  }

  /** Appends a `cleanup` or `abort` line; a write that fails becomes the run's problem and the cleanup goes on. */
  private closingLine(line: NewLedgerLine): void {
    try {
      this.o.file.append(line);
    } catch (e) {
      if (!(e instanceof TrustError)) throw e;
      this.fail(new RunError('internal', e.message));
    }
  }
}
