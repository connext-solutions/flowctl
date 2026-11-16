import type { Locator, Page, Request, Response } from 'playwright';
import type { DriveStep } from '../../src/derive/index.js';

type Call = NonNullable<DriveStep['request']>;

/**
 * No fetch or XHR may start for this long before the drive calls a request window closed: the `NETWORK_IDLE_MS` of
 * ADR 0020 amendment 2026-11-12 section 3.
 */
const IDLE_MS = 1000;
/** The longest the drive waits for a status line, a request to finish or a window to close. */
const WINDOW_MS = 5000;
/** At most this many bursts of requests in one window before the drive calls it unsettled. */
const MAX_BURSTS = 10;

const isCall = (r: Request): boolean =>
  r.resourceType() === 'fetch' || r.resourceType() === 'xhr';

/** Counts the fetch and XHR requests of `page` in flight, from its own events; call once, before the first action. */
export function track(page: Page): () => number {
  let n = 0;
  const done = (r: Request): void => {
    if (isCall(r)) n = Math.max(0, n - 1);
  };
  page.on('request', (r) => {
    if (isCall(r)) n += 1;
  });
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  return () => n;
}

/**
 * Whether the request window of the action just taken closes: every fetch or XHR in flight ends, then none starts for
 * {@link IDLE_MS}. Playwright waits on the page's events (`waitForEvent`, `waitForRequest`), never a timed poll.
 */
async function quiet(page: Page, inflight: () => number): Promise<boolean> {
  const finished = (r: Request): boolean => isCall(r) && inflight() === 0;
  const options = { predicate: finished, timeout: WINDOW_MS };
  const settle = (p: Promise<unknown>): Promise<boolean> =>
    p.then(
      () => true,
      () => false,
    );
  for (let burst = 0; burst < MAX_BURSTS; burst += 1) {
    if (
      inflight() > 0 &&
      !(await Promise.race([
        settle(page.waitForEvent('requestfinished', options)),
        settle(page.waitForEvent('requestfailed', options)),
      ]))
    )
      return false;
    const started = await page
      .waitForRequest(isCall, { timeout: IDLE_MS })
      .then(
        () => true,
        () => false,
      );
    if (!started && inflight() === 0) return true;
  }
  return false;
}

/**
 * Whether `control` is visible and enabled right before an action (ADR 0020 amendment 2026-11-12 section 4):
 * `isVisible`, `isEnabled`, and no `aria-disabled="true"` or `inert` on it or an ancestor.
 */
async function actionable(control: Locator): Promise<boolean> {
  if (!(await control.isVisible()) || !(await control.isEnabled()))
    return false;
  return control.evaluate(
    (e) => e.closest('[aria-disabled="true"],[inert]') === null,
  );
}

/** What one action did: the request it sent, whether its control was actionable and its window settled. */
interface Acted {
  request: Call | null;
  actionable: boolean;
  settled: boolean;
  clientBlocked: boolean;
}

/**
 * Clicks `control` when it is actionable and returns the first answered request to `path` with `method`. It waits
 * until the status line changed (every action of the app writes one) and the request window closed, so the list is
 * redrawn. `clientBlocked` is true only when the control was actionable, the window settled and nothing was sent.
 */
export async function act(
  page: Page,
  inflight: () => number,
  method: string,
  path: RegExp,
  control: Locator,
): Promise<Acted> {
  if (!(await actionable(control)))
    return {
      request: null,
      actionable: false,
      settled: false,
      clientBlocked: false,
    };
  const found: Call[] = [];
  const onResponse = (r: Response): void => {
    const url = new URL(r.url());
    if (r.request().method() === method && path.test(url.pathname))
      found.push({ method, path: url.pathname, status: r.status() });
  };
  const previous = await page.locator('#msg').innerText();
  page.on('response', onResponse);
  try {
    await control.click();
    await page
      .waitForFunction(
        (p) => document.getElementById('msg')?.textContent !== p,
        previous,
        { timeout: WINDOW_MS },
      )
      .catch(() => undefined);
    const settled = await quiet(page, inflight);
    const request = found[0] ?? null;
    return {
      request,
      actionable: true,
      settled,
      clientBlocked: settled && request === null,
    };
  } finally {
    page.off('response', onResponse);
  }
}
