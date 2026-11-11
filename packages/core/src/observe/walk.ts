import { RunError, type RequestGuard, type RunSession } from '../run/index.js';
import type { PageBudget } from './budget.js';
import type { Capture } from './capture.js';
import type { LinkRules } from './links.js';
import { readPage, type PageRead } from './read-page.js';
import type { AppPage } from './schema.js';

/** Navigation failures that end one page, not the crawl: a page that did not answer, or one the scope refused. */
const PAGE_ENDS = new Set(['app_unreachable', 'scope_violation']);

const PATH = /^\/(?!\/)[^?#\s]*$/;

/** What the loop works with: the run, the link rules, the crawl's request layer and the per-page capture. */
export interface Crawl {
  run: RunSession;
  rules: LinkRules;
  writes: RequestGuard;
  capture: Capture;
}

/**
 * The breadth-first loop: reads the start page `begin` opened, then opens each queued path in order, adding the links
 * it may follow to the queue once each, and appends one page per path to `pages`.
 *
 * @remarks A path reached again through a redirect adds no page; what was captured and refused while it was open is
 *   counted on the next page.
 * @returns whether the queue was emptied: false when the page budget (counted in navigations) stopped it, or a list
 *   was cut to its cap.
 * @throws {RunError} what ends the run (`budget_exceeded`, `profile_expired`, an `internal` scope problem).
 */
export async function walk(
  c: Crawl,
  start: string,
  budget: PageBudget,
  pages: AppPage[],
): Promise<boolean> {
  const queue = [start];
  const seen = new Set(queue);
  let cut = false;
  let first = true;
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    if (!budget.take()) return false;
    const read = await visit(c, path, first);
    first = false;
    for (const p of read?.follow ?? [])
      if (!seen.has(p)) {
        seen.add(p);
        queue.push(p);
      }
    const at = read?.path ?? path;
    seen.add(at);
    if (pages.some((p) => p.path === at)) continue;
    cut ||= read?.cut === true || c.capture.cut;
    pages.push({
      path: at,
      title: read?.title ?? '',
      status: read?.status ?? 0,
      controls: read?.controls ?? [],
      links: read?.links ?? [],
      forms: read?.forms ?? [],
      ...c.capture.take(),
      refused: c.writes.takeRefusals(),
    });
  }
  return !cut;
}

/**
 * Opens `path` (the start page is already open), waits for its network to go quiet (at most `stepTimeout`) and reads
 * it; `undefined` when the navigation did not answer or the scope refused it, which ends this page only.
 *
 * @throws {RunError} any other run error, such as `budget_exceeded` or `profile_expired`.
 */
async function visit(
  c: Crawl,
  path: string,
  opened: boolean,
): Promise<PageRead | undefined> {
  const { run } = c;
  const timeout = run.ctx().exec.timeout;
  if (!opened)
    try {
      await run.perform({ kind: 'goto', url: path });
    } catch (e) {
      if (!(e instanceof RunError) || !PAGE_ENDS.has(e.kind)) throw e;
      await run.page
        .waitForURL((u) => u.protocol === 'chrome-error:', { timeout })
        .catch(() => undefined);
      return undefined;
    }
  await run.page
    .waitForLoadState('networkidle', { timeout })
    .catch(() => undefined);
  const at = new URL(run.page.url()).pathname;
  return readPage(run, PATH.test(at) ? at : path, c.rules);
}
