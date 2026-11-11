import { destructiveRequest } from '../browser/index.js';
import { RunError } from '../foundation/index.js';
import type { EnvClass } from '../trust/index.js';
import type { RunLedger } from './ledger/index.js';
import type { Outcome } from './outcome.js';

/** The class of the env a run is on, or `unknown` for a non-loopback origin the trust store does not list. */
export type RequestClass = EnvClass | 'unknown';

/** A refusal a crawl keeps as an observation of the page it came from ({@link RequestGuard.forCrawl}). */
export type Refusal = 'scope_violation' | 'destructive_blocked';

/** The methods a crawl may send: reads only. */
const READS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The request types that can carry a write: a page or form navigation, fetch, XHR, a beacon or `ping`, an event
 * stream, and Chromium's `other`. Scripts, styles, images, fonts and media are not judged, so a bundle chunk named
 * after a component (`DeleteDialog-3f2a.js`) or an icon (`archive.svg`) never stops a run.
 */
const JUDGED_TYPES = new Set([
  'document',
  'fetch',
  'xhr',
  'ping',
  'eventsource',
  'other',
]);

/**
 * The request layer of the destructive-action guard (ADR 0024 section 5, interim, task T1.3): on a `shared`,
 * `production` or `unknown` env it refuses every request {@link destructiveRequest} names (any `DELETE`, a path with
 * a destructive word, a side-effecting `GET` included) before it leaves the browser. It is the line behind the label
 * guard of exploration, and it catches what labels miss: an icon-only control, a confirm dialog's "OK", a script.
 *
 * @remarks The run's scope guard calls {@link allows} for every request and redirect hop, and {@link assertClean}
 *   wherever it checks its own scope, so the run ends `error: destructive_blocked` at its next step or check, and
 *   {@link overrule} keeps any verdict off it. `allowDestructive` lifts the guard on a `shared` env only, and only
 *   while the orchestrator's own steps run ({@link asOrchestrator}): System 1's clicks stay guarded. A replay is
 *   guarded more strictly ({@link forReplay}): every non-GET is refused. A crawl is guarded on every env class
 *   ({@link forCrawl}). On `production` the ADR blocks every non-GET; the exploration form blocks only what it names,
 *   so only {@link forReplay} may judge a production replay. Not caught in an exploration: a write whose path holds
 *   no destructive word (`PUT /items/12`), an action named in the body or query, a GraphQL mutation, a method
 *   override header or `_method` field, a WebSocket message (a crawl closes every WebSocket instead, see
 *   `ScopeGuard`), a destructive request of a script, style or image request type (a crawl refuses any other method
 *   of those types). Not caught in a replay: a destructive `GET` whose path holds no destructive word or which is
 *   sent as a script, style or image, and a WebSocket message.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export class RequestGuard {
  private first: string | undefined;
  private orchestrating = false;
  private runLedger: RunLedger | undefined;
  private stale = false;
  private crawl = false;
  private readonly seen = new Set<Refusal>();

  /**
   * The request layer of a crawl (ADR 0024 section 5, "it covers the crawler ... in every env class"; ADR 0033 decisions 4 and 5): on
   * every env class, `local` included, it refuses every write (any method but `GET`, `HEAD` and `OPTIONS`) and every
   * request {@link destructiveRequest} names. A refusal, and a scope refusal the run's scope guard reports through
   * {@link observes}, is kept for {@link takeRefusals} instead of ending the run: the request is still aborted, and
   * the crawl records it on the page it came from. Only a prevented refusal is kept that way: a request that was
   * already sent when the guard saw it (a redirect hop no hold saw, a frame or download that got past the route)
   * ends the crawl `scope_violation` or `destructive_blocked`, as in any run.
   */
  static forCrawl(
    envClass: RequestClass,
    extraWords: readonly string[],
  ): RequestGuard {
    const g = new RequestGuard(envClass, false, extraWords);
    g.crawl = true;
    return g;
  }

  /**
   * @param extraWords the repo's `target.destructiveWords`, already narrowed by the effective configuration.
   * @param replayOf the name of the flow a replay runs ({@link forReplay}); `undefined` for an exploration.
   */
  constructor(
    readonly envClass: RequestClass,
    private readonly allowDestructive: boolean,
    private readonly extraWords: readonly string[] = [],
    private readonly replayOf?: string,
  ) {}

  /**
   * The request layer of a replay of `flow` (ADR 0024 section 5): on a `shared`, `production` or `unknown` env it
   * refuses every request that is not a `GET`, of any resource type (`HEAD` included), and every `GET` that
   * {@link destructiveRequest} names, of a type in {@link JUDGED_TYPES}; on `local` it refuses nothing.
   *
   * @remarks A `destructiveConfirm` entry is the only thing that lets a replay write on `shared`: with
   *   {@link useLedger}, a `fetch` or `xhr` write an entry matches is sent ({@link ledgerFor}); every other write is
   *   refused, and the hint says which confirmation is missing. Production hosts are
   *   already unreachable through the scope guard, which judges a request first; this layer is the second line.
   *   `allowDestructive` and {@link asOrchestrator} do not apply to a replay.
   */
  static forReplay(
    envClass: RequestClass,
    flow: string,
    extraWords: readonly string[] = [],
  ): RequestGuard {
    return new RequestGuard(envClass, false, extraWords, flow);
  }

  /**
   * Lets stored confirmations authorise writes of this replay through `ledger` (ADR 0024 section 5): a `fetch` or
   * `xhr` request that is not a `GET` is then judged by {@link RunLedger.authorise} instead of refused.
   */
  useLedger(ledger: RunLedger): void {
    this.runLedger = ledger;
  }

  /** The run ledger, when stored confirmations apply to this replay. */
  get ledger(): RunLedger | undefined {
    return this.runLedger;
  }

  /** Notes that the store holds entries for this flow and env, but for another version of the flow. */
  staleConfirmations(): void {
    this.stale = true;
  }

  /** The ledger to judge a request of `method` and resource `type` with, or `undefined` for the plain rules. */
  ledgerFor(method: string, type: string): RunLedger | undefined {
    return this.replayOf !== undefined &&
      this.envClass === 'shared' &&
      this.runLedger?.defers(method, type) === true
      ? this.runLedger
      : undefined;
  }

  /** Notes a write the ledger refused, with `why` (no entry matched, an id the run did not create, a name rule). */
  refuseWrite(method: string, url: string, why: string): void {
    this.first ??= `flowctl stopped ${method.toUpperCase()} ${pathOf(url)} in a replay on a shared env: ${why}. ${this.replayRemedy()}`;
  }

  /**
   * Whether a request may be sent, noting a refusal when not.
   *
   * @param type the request's resource type (Playwright's, or CDP's in any case); outside a crawl, one outside
   *   {@link JUDGED_TYPES} is always allowed. A crawl checks the method first, for every type: a `POST` of a type
   *   the guard does not otherwise judge (a CSP report) is refused, a `GET` script or image is not.
   * @param prevented whether a refusal stops the request before it is sent (a route abort, a failed redirect hop);
   *   false when the request was already sent and is only detected (a redirect hop the hold did not see). A crawl
   *   keeps only prevented refusals as observations of the page; a detected one ends the run as in any run.
   */
  allows(method: string, url: string, type: string, prevented = true): boolean {
    if (this.envClass === 'local' && !this.crawl) return true;
    if (this.replayOf !== undefined)
      return this.allowsReplay(method, url, type, prevented);
    if (
      this.envClass === 'shared' &&
      this.allowDestructive &&
      this.orchestrating
    )
      return true;
    const m = method.toUpperCase();
    const write = this.crawl && !READS.has(m);
    if (!write && !JUDGED_TYPES.has(type.toLowerCase())) return true;
    const word = write ? m : destructiveRequest(method, url, this.extraWords);
    if (word === undefined) return true;
    if (prevented && this.observes('destructive_blocked')) return false;
    this.first ??= `flowctl ${prevented ? 'stopped' : 'saw'} ${m} ${pathOf(url)}, which looks destructive ("${word}") on a ${this.envClass} env. ${this.remedy()}`;
    return false;
  }

  private allowsReplay(
    method: string,
    url: string,
    type: string,
    prevented: boolean,
  ): boolean {
    const m = method.toUpperCase();
    const word =
      m !== 'GET'
        ? m
        : JUDGED_TYPES.has(type.toLowerCase())
          ? destructiveRequest(m, url, this.extraWords)
          : undefined;
    if (word === undefined) return true;
    const why =
      m === 'GET' ? `a GET that looks destructive ("${word}")` : 'a write';
    this.first ??= `flowctl ${prevented ? 'stopped' : 'saw'} ${m} ${pathOf(url)}, ${why}, in a replay on a ${this.envClass} env. ${this.replayRemedy()}`;
    return false;
  }

  private replayRemedy(): string {
    if (this.envClass === 'unknown')
      return "The trust store does not list the env's origin, and a replay never writes on such an env: classify it with flowctl trust add env <env>.";
    if (this.envClass === 'production')
      return 'A replay never writes on production (ADR 0024 section 2a).';
    const flow = this.replayOf ?? '';
    const why = this.stale
      ? `the destructiveConfirm entries for flow "${flow}" were confirmed for another version of it (the flow, a file it uses or an env var changed)`
      : `a replay writes on a shared env only what a destructiveConfirm entry for flow "${flow}" in this machine's trust store authorises`;
    return `Here ${why}. Confirm the flow once from a recorded local run: flowctl trust add destructive ${flow} --env <env> --from-run <run id> (ADR 0024 section 5), or replay it on a local env.`;
  }

  /** Whether this is a crawl's request layer ({@link forCrawl}): the scope guard then closes every WebSocket. */
  get crawling(): boolean {
    return this.crawl;
  }

  /**
   * Runs `work` as the orchestrator's: with `allowDestructive` on a `shared` env, its requests pass. A request the
   * page sends after `work` ends is judged again.
   */
  async asOrchestrator<T>(work: () => Promise<T>): Promise<T> {
    this.orchestrating = true;
    try {
      return await work();
    } finally {
      this.orchestrating = false;
    }
  }

  /** In a crawl, keeps `kind` as an observation of the open page and returns true; otherwise false. */
  observes(kind: Refusal): boolean {
    if (this.crawl) this.seen.add(kind);
    return this.crawl;
  }

  /** The refusals kept since the last call, sorted; a crawl takes them after each page. */
  takeRefusals(): Refusal[] {
    const kinds = [...this.seen].sort();
    this.seen.clear();
    return kinds;
  }

  /** The first refusal of the run, if any. */
  get refusal(): string | undefined {
    return this.first;
  }

  /**
   * @throws {RunError} the ledger's problem (`ledger_replay`, `ledger_mismatch`, `ledger_overflow`), else
   *   `destructive_blocked` naming the first request the guard stopped.
   */
  assertClean(): void {
    const p = this.runLedger?.problem;
    if (p !== undefined) throw p;
    if (this.first !== undefined)
      throw new RunError('destructive_blocked', this.first);
  }

  /** `outcome`, or the error {@link assertClean} would throw when there is one and `outcome` is not already an error. */
  overrule(outcome: Outcome): Outcome {
    if (outcome.status === 'error') return outcome;
    const p = this.runLedger?.problem;
    if (p !== undefined)
      return { status: 'error', error: { kind: p.kind, hint: p.hint } };
    return this.first !== undefined
      ? {
          status: 'error',
          error: { kind: 'destructive_blocked', hint: this.first },
        }
      : outcome;
  }

  private remedy(): string {
    return this.envClass === 'shared'
      ? 'To send it, start the exploration again with allowDestructive: true and take that step yourself, on data the run created.'
      : 'allowDestructive applies only to an env the trust store classes shared.';
  }
}

/** The origin and path of `url`, without its query or fragment, which may carry tokens (capped at 200 characters). */
function pathOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.slice(0, 200);
  } catch {
    return url.slice(0, 80);
  }
}
