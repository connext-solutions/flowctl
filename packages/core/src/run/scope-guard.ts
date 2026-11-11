import type {
  BrowserContext,
  Page,
  Request,
  Route,
  WebSocketRoute,
} from 'playwright';
import { inScope, type Scope, type ScopeKind } from '../browser/index.js';
import type { LoadedConfig, ResolvedEnv } from '../config.js';
import { RunError, type ErrorKind } from '../foundation/index.js';
import type { Outcome } from './outcome.js';
import { errorMessage } from './outcome.js';
import { watchFrames } from './frames.js';
import { answerFirstHop, holdRedirects } from './redirect-hold.js';
import type { RequestGuard } from './request-guard.js';
import { TrustError, type TrustStore } from '../trust/index.js';
import { scopeFor } from './scope-for.js';

/** A WebSocket URL judged as the http(s) URL of its handshake: `wss:` as `https:`, `ws:` as `http:`. */
const asHttp = (url: string): string => url.replace(/^ws(s?):/i, 'http$1:');

/** The request classes a page opens as a page (`visit`); every other class is a `call`. */
const DOCUMENT = 'document';

/**
 * Enforces a run's {@link Scope} on its browser contexts (ADR 0024 section 3, task T1.2):
 * - every request a context makes is routed: one out of scope is aborted before it leaves the browser, and noted;
 * - WebSockets go through `routeWebSocket` the same way, as `call`; in a crawl ({@link RequestGuard.crawling}) every
 *   one is closed, since a frame on it could carry a write no route sees;
 * - service workers are blocked on the context (`serviceWorkers: 'block'`, set by the caller), so none can serve or
 *   send requests the route does not see;
 * - a frame is a visit: one out of scope is not entered, and a URL change of any frame without a request
 *   (`history.pushState`, a hash route, a `data:` frame) is checked when it happens ({@link watchFrames});
 * - a redirect answer whose `Location` is out of scope is failed before the browser sends the hop
 *   ({@link holdRedirects}, also on a cross-site frame in its own process; a popup's first navigation through
 *   {@link answerFirstHop}); a hop neither sees (a worker, a later hop of a popup's first navigation) is still
 *   detected;
 * - downloads are cancelled and judged like any request (`run/context-limits.ts`).
 *
 * The first problem is kept with its kind: a request or page out of scope (`scope_violation`), a page the hold could
 * not be attached to (`internal`), a popup whose first answer could not be fetched (`app_unreachable`).
 * {@link assertClean} throws it and {@link overrule} turns the run's outcome into it. A crawl keeps a scope refusal
 * that stopped the request before it was sent (route, hold, first hop, a page check before navigating, a URL change
 * that sends nothing) as an observation of its page; one only detected after the request was sent ({@link detect})
 * ends the crawl too (ADR 0033 decision 5).
 *
 * @remarks A same-page URL change happens in the page before flowctl can see it, so it is detected, not prevented.
 *   A popup in scope whose first answer cannot be fetched (a dead link) ends the run `app_unreachable`, where a plain
 *   browser would show an error page; a broken link is reported as infrastructure, not as a product bug.
 *   Uploads come only from `<flows root>/fixtures/` (`readFixture`); WebRTC and WebTransport are disabled, best
 *   effort, by `limitContext`, not by this guard.
 */
export class ScopeGuard {
  private first: RunError | undefined;
  private readonly held = new WeakMap<Page, Promise<boolean>>();

  /**
   * @param writes the request layer of the destructive-action guard, when the caller set one (exploration does):
   *   every request and redirect hop in scope is also put to it.
   */
  constructor(
    readonly scope: Scope,
    readonly writes?: RequestGuard,
  ) {}

  /**
   * Whether a request of resource `type` sending `method url` may be reached as `kind`: in scope, and not a write the
   * request layer refuses. `prevented` as in {@link check}.
   */
  private judge(
    url: string,
    kind: ScopeKind,
    method: string,
    type: string,
    prevented = true,
  ): boolean {
    return (
      this.check(url, kind, prevented) &&
      (this.writes?.allows(method, url, type, prevented) ?? true)
    );
  }

  /** Every origin the run may visit or call: the only ones its `url` and `network` assertions match (issue #47). */
  get origins(): readonly string[] {
    return [...this.scope.visit, ...this.scope.call];
  }

  /** The first violation of the run so far, if any. */
  get violation(): string | undefined {
    return this.first?.kind === 'scope_violation' ? this.first.hint : undefined;
  }

  /** Whether `url` may be reached as `kind`, noting a violation when not; the caller stops it before it is sent. */
  allows(url: string, kind: ScopeKind): boolean {
    return this.check(url, kind, true);
  }

  /** Whether `url`, already reached as `kind` (a cancelled download that got past the route), was in scope; a violation ends the run, crawl included. */
  detect(url: string, kind: ScopeKind): boolean {
    return this.check(url, kind, false);
  }

  /** @param prevented whether a refusal stops the request before it is sent, or only detects it afterwards. */
  private check(url: string, kind: ScopeKind, prevented: boolean): boolean {
    const v = inScope(url, kind, this.scope);
    if (!v.ok)
      this.note(
        'scope_violation',
        `The run left its scope: ${kind} ${url.slice(0, 200)}: ${v.reason}`,
        prevented,
      );
    return v.ok;
  }

  /**
   * Routes every request and WebSocket of `context` through the scope; call before its first page opens.
   *
   * @remarks A request continues only once its page is held ({@link hold}), so a popup's first answer cannot be a
   *   redirect the hold has not seen yet. A service worker's request has no page; workers are blocked anyway.
   */
  async attach(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route: Route) => {
      const r = route.request();
      const kind: ScopeKind = r.resourceType() === DOCUMENT ? 'visit' : 'call';
      if (!this.judge(r.url(), kind, r.method(), r.resourceType()))
        return route.abort('blockedbyclient');
      const page = this.pageOf(r);
      if (page === undefined)
        return r.isNavigationRequest()
          ? answerFirstHop(
              route,
              (url, k, m, t) => this.judge(url, k, m, t),
              (why) =>
                this.note(
                  'app_unreachable',
                  `A popup could not load: ${why}. Check that the app is up and the link works in a browser.`,
                ),
            )
          : route.continue();
      return (await this.hold(page))
        ? route.continue()
        : route.abort('blockedbyclient');
    });
    await context.routeWebSocket(/.*/, (ws: WebSocketRoute) =>
      this.allows(asHttp(ws.url()), 'call') && this.writes?.crawling !== true
        ? ws.connectToServer()
        : ws.close(),
    );
    context.on('request', (r) => {
      if (r.redirectedFrom() !== null)
        this.judge(
          r.url(),
          r.resourceType() === DOCUMENT ? 'visit' : 'call',
          r.method(),
          r.resourceType(),
          false,
        );
    });
    context.on('page', (page) => void this.hold(page));
  }

  /**
   * Holds `page` to the scope, once: its main-frame URL changes ({@link watch}) and its redirect hops, failed before
   * the browser follows one out of scope ({@link holdRedirects}).
   *
   * @returns whether the page is held; when not, the run's problem is `internal` (unless an earlier one was kept)
   *   and the page's requests are aborted, so nothing leaves unchecked. A page that closed before its hold was
   *   attached (a popup that closes itself, as a download link does) sends nothing, so it is not a problem.
   */
  hold(page: Page): Promise<boolean> {
    const known = this.held.get(page);
    if (known !== undefined) return known;
    this.watch(page);
    const held = holdRedirects(page, (url, kind, method, type) =>
      this.judge(url, kind, method, type),
    ).then(
      () => true,
      (e: unknown) => {
        if (!page.isClosed())
          this.note(
            'internal',
            `flowctl could not watch the redirects of a page (it needs Chromium, and a page that is still open): ${errorMessage(e)}`,
          );
        return false;
      },
    );
    this.held.set(page, held);
    return held;
  }

  /** Keeps the run's first problem; a crawl's request layer takes a prevented scope refusal as an observation instead. */
  private note(kind: ErrorKind, hint: string, prevented = true): void {
    if (
      kind === 'scope_violation' &&
      prevented &&
      this.writes?.observes(kind) === true
    )
      return;
    this.first ??= new RunError(kind, hint);
  }

  /**
   * The page that sent `r`, or `undefined` for a service worker's request and for the first navigation of a popup,
   * which Playwright reports before it creates the popup's frame (`frame()` throws for it, and only for it). That
   * request is answered through {@link answerFirstHop}; the popup is held from the context's `page` event.
   */
  private pageOf(r: Request): Page | undefined {
    if (r.serviceWorker() !== null) return undefined;
    if (!r.isNavigationRequest()) return r.frame().page();
    try {
      return r.frame().page();
    } catch {
      return undefined;
    }
  }

  /** Checks every frame URL change of `page`, main frame and subframes, including those that send no request ({@link watchFrames}). */
  watch(page: Page): void {
    watchFrames(
      page,
      (url, sent) => void this.check(url, 'visit', !sent),
      (url, kind, method, type) => this.judge(url, kind, method, type),
    );
  }

  /**
   * `outcome`, or the run's first problem (see the class) when there is one and `outcome` is not already an error,
   * then the request layer's refusal ({@link RequestGuard.overrule}): no verdict stands on such a run.
   */
  overrule(outcome: Outcome): Outcome {
    const scoped = this.overruleScope(outcome);
    return this.writes?.overrule(scoped) ?? scoped;
  }

  private overruleScope(outcome: Outcome): Outcome {
    return this.first !== undefined && outcome.status !== 'error'
      ? {
          status: 'error',
          error: { kind: this.first.kind, hint: this.first.hint },
        }
      : outcome;
  }

  /**
   * @throws {RunError} the run's first problem: `scope_violation` naming the first request or page out of scope,
   *   `internal` for a page the redirect hold could not watch, `app_unreachable` for a popup that could not load.
   */
  assertClean(): void {
    if (this.first !== undefined) throw this.first;
    this.writes?.assertClean();
  }
}

/**
 * The scope guard of a run on `env` ({@link scopeFor}).
 *
 * @throws {RunError} `scope_violation` when the trust store cannot be read for the production hosts.
 */
export function guardFor(
  cfg: LoadedConfig,
  env: ResolvedEnv,
  store: TrustStore | 'default',
  writes?: RequestGuard,
): ScopeGuard {
  try {
    return new ScopeGuard(scopeFor(cfg, env, store), writes);
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    throw new RunError(
      'scope_violation',
      `The trust store refused the run's scope (${e.kind}${e.detail === undefined ? '' : `: ${e.detail}`}): ${e.message}`,
    );
  }
}
