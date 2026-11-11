import type { Frame, Page, Request } from 'playwright';
import { RunError, type RequestGuard, type RunSession } from '../run/index.js';
import type { PageBudget } from './budget.js';
import type { Capture } from './capture.js';
import { mayOpen, type LinkRules } from './links.js';
import { readPage, redactor, type PageRead } from './read-page.js';
import { PAGE_PATH, type AppPage } from './schema.js';

/** Navigation failures that end one page, not the crawl: a page that did not answer, or one the scope refused. */
const PAGE_ENDS = new Set(['app_unreachable', 'scope_violation']);

/**
 * The longest a crawl waits for one page to settle (its network quiet, or the error page of a refused load), in ms,
 * capped by `stepTimeout`. A page that polls never goes quiet; waiting the whole `stepTimeout` on each would spend
 * most of a crawl waiting. A call that comes later is counted on the next page.
 */
export const SETTLE_MS = 2_000;

/** What the loop works with: the run, the link rules, the crawl's request layer, the per-page capture and the profile. */
export interface Crawl {
  run: RunSession;
  rules: LinkRules;
  writes: RequestGuard;
  capture: Capture;
  profile: string;
}

/**
 * The breadth-first loop: reads the start page `begin` opened, then opens each queued path in order, adding the links
 * it may follow to the queue once each, and appends one page per path to `pages`.
 *
 * @remarks A path reached again through a redirect adds no page; what was captured and refused while it was open is
 *   counted on the next page.
 * @returns whether the queue was emptied: false when the page budget (counted in navigations) stopped it, or a list
 *   was cut to its cap.
 * @throws {RunError} what ends the run (`budget_exceeded`, `profile_expired`, an `internal` scope problem, a
 *   `scope_violation` or `destructive_blocked` detected only after the request was sent), checked after each page.
 */
export async function walk(
  c: Crawl,
  start: string,
  budget: PageBudget,
  pages: AppPage[],
): Promise<boolean> {
  const queue = [start];
  const seen = new Set(queue);
  const recorded = new Set<string>();
  const red = redactor(c.run.secrets);
  let cut = false;
  let first = true;
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (!budget.take()) return false;
    const { read, navigationRefused } = await visit(c, path, first);
    first = false;
    for (const p of read?.follow ?? [])
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    const at = read?.path ?? path;
    seen.add(at);
    if (recorded.has(at)) continue;
    recorded.add(at);
    cut ||= read?.cut === true || c.capture.cut;
    pages.push({
      path: red(at),
      title: read?.title ?? '',
      status: read?.status ?? 0,
      controls: read?.controls ?? [],
      links: read?.links ?? [],
      forms: read?.forms ?? [],
      ...c.capture.take(),
      refused: c.writes.takeRefusals(),
      navigationRefused,
    });
    c.run.assertInScope();
  }
  return !cut;
}

/** What {@link visit} found: the page read (`undefined` when it did not open), and whether the guards refused its navigation. */
interface Visit {
  read: PageRead | undefined;
  navigationRefused: boolean;
}

/** The error text of a request flowctl aborted: a route abort or a failed redirect hop (`BlockedByClient`). */
const BLOCKED = 'net::ERR_BLOCKED_BY_CLIENT';

/**
 * Whether `r` is the main-frame navigation of `page` to `target` (its first request, or a redirect hop of it) and
 * flowctl's guards aborted it.
 */
function refusedNavigation(r: Request, page: Page, target: URL): boolean {
  if (!r.isNavigationRequest() || r.frame() !== page.mainFrame()) return false;
  if (r.failure()?.errorText !== BLOCKED) return false;
  let first = r;
  for (
    let from = r.redirectedFrom();
    from !== null;
    from = from.redirectedFrom()
  )
    first = from;
  const u = new URL(first.url());
  return u.origin === target.origin && u.pathname === target.pathname;
}

/**
 * Opens `path` (the start page is already open), waits for its network to go quiet (at most {@link SETTLE_MS}) and
 * reads it under the path it ended on (after a redirect in scope), or under `path` when that one is not a path a crawl
 * may open (a `pushState` to a denied path); `read` is `undefined` when the navigation did not answer or the scope
 * refused it before it was sent, which ends this page only. Only a load the browser started (`app_unreachable`, as
 * after a route abort or an empty answer) waits for its own error page to commit; a navigation refused before it
 * started does not wait.
 *
 * @remarks The wait is for a main-frame commit of an error page after this navigation started, not for the URL: when
 *   the page before also failed, the URL is already `chrome-error:`, and the late commit of this page's error page
 *   would interrupt the next navigation. `navigationRefused` is true when the scope check before navigating refused
 *   `path`, or when the guards aborted the page's own navigation request or one of its redirect hops. A refusal of
 *   any other request (a late call or beacon of the page before) does not set it, so it cannot hide a page that did
 *   not answer.
 * @throws {RunError} `profile_expired` when the page ended under the env's login path, including a client-side
 *   redirect after it loaded (a single-page app on a 401); any other run error, such as `budget_exceeded` or a
 *   violation the scope guard detected after the request was sent.
 */
async function visit(c: Crawl, path: string, opened: boolean): Promise<Visit> {
  const { run } = c;
  const timeout = Math.min(SETTLE_MS, run.ctx().exec.timeout);
  if (opened)
    return { read: await readOpen(c, path, timeout), navigationRefused: false };
  const page = run.page;
  const target = new URL(path, run.env.baseUrl);
  const errorPage = (f: Frame): boolean =>
    f === page.mainFrame() && f.url().startsWith('chrome-error:');
  let navigationRefused = false;
  let errorShown = false;
  const onFailed = (r: Request): void => {
    navigationRefused ||= refusedNavigation(r, page, target);
  };
  const onNavigated = (f: Frame): void => {
    errorShown ||= errorPage(f);
  };
  page.on('requestfailed', onFailed);
  page.on('framenavigated', onNavigated);
  try {
    await run.perform({ kind: 'goto', url: path });
  } catch (e) {
    run.assertInScope();
    if (!(e instanceof RunError) || !PAGE_ENDS.has(e.kind)) throw e;
    if (e.kind === 'scope_violation') navigationRefused = true;
    else if (!errorShown)
      await page
        .waitForEvent('framenavigated', { predicate: errorPage, timeout })
        .catch(() => undefined);
    return { read: undefined, navigationRefused };
  } finally {
    page.off('requestfailed', onFailed);
    page.off('framenavigated', onNavigated);
  }
  return { read: await readOpen(c, path, timeout), navigationRefused };
}

/**
 * Waits for the open page's network to go quiet and reads it ({@link visit}).
 *
 * @throws {RunError} `profile_expired` when the page ended under the env's login path; run errors from the read.
 */
async function readOpen(
  c: Crawl,
  path: string,
  timeout: number,
): Promise<PageRead> {
  const { run } = c;
  await run.page
    .waitForLoadState('networkidle', { timeout })
    .catch(() => undefined);
  const at = new URL(run.page.url()).pathname;
  const login = c.rules.loginUrl;
  if (login !== undefined && at.startsWith(login))
    throw new RunError(
      'profile_expired',
      `Profile "${c.profile}" was sent to the login page ${login} while ${path} was open. Run: flowctl login ${c.profile} --env ${run.env.name}`,
    );
  const origin = new URL(run.env.baseUrl).origin;
  return readPage(
    run,
    PAGE_PATH.test(at) && mayOpen(at, origin, c.rules) ? at : path,
    c.rules,
  );
}
