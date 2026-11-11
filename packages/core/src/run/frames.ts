import type { Frame, Page } from 'playwright';
import { holdRedirects, type Judge } from './redirect-hold.js';

/**
 * URLs a frame can show that are not a visit: a new page or frame (`about:blank`), an inline frame (`about:srcdoc`,
 * which keeps its parent's origin), and the page Chromium shows for a load that failed, including one the scope
 * guard aborted (`chrome-error:`), so a failed load stays `app_unreachable`.
 */
const notAVisit = (url: string): boolean =>
  url === 'about:blank' ||
  url === 'about:srcdoc' ||
  url.startsWith('chrome-error:');

/**
 * Holds every frame of `page` to the scope as a visit (ADR 0024 section 3, rule 7):
 * - every URL change of the main frame or a subframe is judged, including those that send no request and so reach
 *   no route: `history.pushState`, a hash route, a `data:` or `blob:` frame (refused by rule 1). These are detected
 *   when they happen, not prevented;
 * - a cross-site frame in its own process (site isolation, which flowctl's own launch leaves off but a caller's
 *   browser may turn on) gets its own redirect hold ({@link holdRedirects}) once it has committed, so its later
 *   redirect hops and `download` links are refused before they are sent, as in the page's own process.
 *
 * @param visit judges a URL as a page visit, noting a violation when it is out of scope. `sent` tells whether the
 *   change can have sent a request: an http(s) URL on another origin than the frame's last one, or a frame's first
 *   http(s) URL, is a document load that got past the route and the hold (detected after the fact). A change on the
 *   same origin is taken as one that sends nothing (`pushState`, a hash route): a same-origin load out of scope is
 *   stopped by the route or the hold before it commits, and its later hops are judged by the guard's `request`
 *   listener. A URL with no network (`data:`, `blob:`) sends nothing either.
 * @remarks A frame request out of scope never loads: Playwright's context route aborts it in any process, and the
 *   page's hold fails a redirect hop of a frame's first navigation. A frame that shares its parent's process has no
 *   target of its own; opening a session on it fails and is retried on its next navigation, since a frame can move
 *   to its own process later. A frame held once that moves to a third site's process is held no more, and a
 *   navigation the frame starts before its hold is attached (a redirect right after it commits) is not held: those
 *   hops are still detected by the guard's `request` listener.
 */
export function watchFrames(
  page: Page,
  visit: (url: string, sent: boolean) => void,
  judge: Judge,
): void {
  const held = new WeakMap<Frame, Promise<void>>();
  const origins = new WeakMap<Frame, string>();
  const sent = (f: Frame, url: string): boolean => {
    if (!/^https?:/i.test(url)) return false;
    const origin = new URL(url).origin;
    const last = origins.get(f);
    origins.set(f, origin);
    return last !== origin;
  };
  const hold = (f: Frame): void => {
    if (held.has(f)) return;
    held.set(
      f,
      holdRedirects(page, judge, f).catch(() => {
        held.delete(f);
      }),
    );
  };
  page.on('framenavigated', (f) => {
    const url = f.url();
    if (!notAVisit(url)) visit(url, sent(f, url));
    if (f !== page.mainFrame() && !f.isDetached()) hold(f);
  });
}
