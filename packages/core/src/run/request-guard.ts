import { destructiveRequest } from '../browser/index.js';
import { RunError } from '../foundation/index.js';
import type { EnvClass } from '../trust/index.js';
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
 *   while the orchestrator's own steps run ({@link asOrchestrator}): System 1's clicks stay guarded. Replay is not
 *   guarded yet; the stored confirmations that would let a reviewed flow write on `shared` come with a later chunk.
 *   On `production` the ADR blocks every non-GET; this interim layer blocks only what it names, so it must not be
 *   reused for a production replay as it is. Not caught: a write whose path holds no destructive word (`PUT
 *   /items/12`), an action named in the body or query, a GraphQL mutation, a method override header or `_method`
 *   field, a WebSocket message, a destructive request from a script, style or image request type.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export class RequestGuard {
  private first: string | undefined;
  private orchestrating = false;
  private crawl = false;
  private readonly seen = new Set<Refusal>();

  /**
   * The request layer of a crawl (ADR 0024 section 5, "it covers the crawler ... in every env class"; ADR 0033 decisions 4 and 5): on
   * every env class, `local` included, it refuses every write (any method but `GET`, `HEAD` and `OPTIONS`) and every
   * request {@link destructiveRequest} names. A refusal, and a scope refusal the run's scope guard reports through
   * {@link observes}, is kept for {@link takeRefusals} instead of ending the run: the request is still aborted, and
   * the crawl records it on the page it came from.
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
   */
  constructor(
    readonly envClass: RequestClass,
    private readonly allowDestructive: boolean,
    private readonly extraWords: readonly string[] = [],
  ) {}

  /**
   * Whether a request may be sent, noting a refusal when not.
   *
   * @param type the request's resource type (Playwright's, or CDP's in any case); one outside {@link JUDGED_TYPES}
   *   is always allowed.
   */
  allows(method: string, url: string, type: string): boolean {
    if (this.envClass === 'local' && !this.crawl) return true;
    if (
      this.envClass === 'shared' &&
      this.allowDestructive &&
      this.orchestrating
    )
      return true;
    if (!JUDGED_TYPES.has(type.toLowerCase())) return true;
    const m = method.toUpperCase();
    const word =
      this.crawl && !READS.has(m)
        ? m
        : destructiveRequest(method, url, this.extraWords);
    if (word === undefined) return true;
    if (this.observes('destructive_blocked')) return false;
    this.first ??= `flowctl stopped ${method.toUpperCase()} ${pathOf(url)}, which looks destructive ("${word}") on a ${this.envClass} env. ${this.remedy()}`;
    return false;
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

  /** @throws {RunError} `destructive_blocked` naming the first request the guard stopped. */
  assertClean(): void {
    if (this.first !== undefined)
      throw new RunError('destructive_blocked', this.first);
  }

  /** `outcome`, or `error: destructive_blocked` when a request was refused and `outcome` is not already an error. */
  overrule(outcome: Outcome): Outcome {
    return this.first !== undefined && outcome.status !== 'error'
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
