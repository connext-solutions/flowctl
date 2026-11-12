import type { Page } from 'playwright';
import { frameTexts } from '../../browser/index.js';
import { RunError } from '../../foundation/index.js';
import { MAX_TEXT_BYTES, SeenSet } from './seen.js';

/** The request types whose URL and body enter the seen-set (those the request layer judges). */
const SCANNED_REQUESTS = new Set([
  'document',
  'fetch',
  'xhr',
  'ping',
  'eventsource',
  'other',
]);

/**
 * The seen-set side of a run ledger (ADR 0024 amendment 2026-11-12 "destructive ledger details", section 1): what the
 * run scans for id-shaped tokens, the response scans still in flight, and the run's first ledger problem.
 *
 * @remarks `RunLedger` extends it; it is apart only to keep each file small. An overflow of a scan is kept as
 *   {@link problem}, never thrown at the page.
 */
export class LedgerScans {
  readonly seen: SeenSet | undefined;
  private first: RunError | undefined;
  private readonly pending = new Set<Promise<void>>();

  /** @param scanning whether a `create` entry applies: only then does the run keep a seen-set. */
  constructor(scanning: boolean) {
    this.seen = scanning ? new SeenSet() : undefined;
  }

  /** The first ledger problem of the run, if any. */
  get problem(): RunError | undefined {
    return this.first;
  }

  /** Keeps the first problem; later ones are dropped. */
  fail(e: RunError): void {
    this.first ??= e;
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

  /**
   * Scans the text of every frame of every page in `pages` (every open page of the run), then waits for every response
   * scan in flight. A page or frame that closed meanwhile adds nothing.
   *
   * @remarks The text is read through CDP ({@link frameTexts}), never with `frame.evaluate`, whose result a safe trace
   *   records (ADR 0030 amendment 2026-11-12).
   */
  async scanPages(pages: readonly Page[]): Promise<void> {
    if (this.seen === undefined) return;
    for (const p of pages)
      for (const text of await frameTexts(p))
        this.guarded(() =>
          this.seen?.add(text, 'the page text', MAX_TEXT_BYTES),
        );
    await this.settle();
  }

  /** Adds the tokens of `text` to the seen-set; an overflow becomes the run's problem. */
  see(text: string, what: string): void {
    this.guarded(() => this.seen?.add(text, what));
  }

  /** Waits for every response scan in flight (each one never rejects). */
  async settle(): Promise<void> {
    await Promise.allSettled(this.pending);
  }

  /**
   * Whether the canonical `id` appeared earlier in the run, once every response scan in flight has finished: a body
   * that holds the id and is still being read when a create answers counts as seen (ledger rule 2).
   */
  async seenBefore(id: string): Promise<boolean> {
    await this.settle();
    return this.seen?.has(id) === true;
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (e) {
      if (e instanceof RunError) this.fail(e);
      else throw e;
    }
  }
}
