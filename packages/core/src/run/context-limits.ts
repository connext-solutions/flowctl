import type { BrowserContext, Download } from 'playwright';
import type { NetEntry } from './net-entry.js';

/**
 * Options every browser context of a run is created with (ADR 0024 section 3, rule 6):
 * - `serviceWorkers: 'block'`: no worker can serve or send requests the scope guard's route does not see;
 * - `acceptDownloads: false`: Chromium cancels every download, so a run never writes a file to disk, in the run
 *   directory or anywhere else (with the default `true` Playwright keeps each download in a temporary directory).
 *
 * @remarks A download is still a request: a link answered with an attachment is a navigation the guard's route
 *   judges, and a `download` link on the page's own origin, which Playwright's route does not see, is judged at
 *   the request stage of the redirect hold, so one out of scope is never sent. Flows cannot ask for a download yet.
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export const RUN_CONTEXT = {
  serviceWorkers: 'block',
  acceptDownloads: false,
} as const;

/** The value of {@link NetEntry.note} for a download the browser cancelled. */
export const DOWNLOAD_NOTE = 'download_cancelled';

/**
 * Interfaces a page script could open a connection with that no route sees (ADR 0024 section 3, rule 6): WebRTC
 * (UDP to any host) and WebTransport (HTTP/3).
 */
export const NO_ROUTE_APIS = [
  'RTCPeerConnection',
  'webkitRTCPeerConnection',
  'WebTransport',
] as const;

/**
 * Page script run before any page script of every frame: each of {@link NO_ROUTE_APIS} becomes a function that
 * throws `NotAllowedError`, fixed so the page cannot put the original back.
 */
const NO_ROUTE_SCRIPT = `(() => {
  for (const name of ${JSON.stringify(NO_ROUTE_APIS)}) {
    if (!(name in globalThis)) continue;
    const blocked = function () {
      throw new DOMException(name + ' is disabled in flowctl runs (ADR 0024)', 'NotAllowedError');
    };
    Object.defineProperty(globalThis, name, { value: blocked, writable: false, configurable: false });
  }
})();`;

/**
 * The URL of a download as the evidence keeps it: an http(s) or `blob:` URL as it is (masked later with the rest of
 * the network log), any other scheme by its name only, so a `data:` export the page built keeps its content out of
 * the evidence (ADR 0030).
 */
export function downloadUrl(url: string): string {
  return /^(https?|blob):/i.test(url)
    ? url
    : `${/^[a-z][a-z0-9+.-]*:/i.exec(url)?.[0] ?? ''}…`;
}

/**
 * Applies the limits {@link RUN_CONTEXT} cannot set to `context`, before its first page opens:
 * - WebRTC and WebTransport disabled in every frame by an init script, **best effort** (rule 6): a dedicated or
 *   shared worker gets no init script and keeps `WebTransport`, so no WebRTC or WebTransport call is ever part of a
 *   verdict;
 * - every download the browser cancelled is noted in the network log as `DOWNLOAD <url>` with status 0 and
 *   `note: 'download_cancelled'` (never seen by a `network` assertion, ADR 0010), and its http(s) URL is put to the
 *   scope again: one that got past the route and the hold (a frame or popup neither held) was already sent, so it
 *   ends the run `scope_violation`, a crawl included. A `blob:` or `data:` download sends nothing and is only noted.
 *
 * @param note adds an entry to the run's network log.
 * @param visit judges a URL already reached as a page visit, noting a violation when it is out of scope (the run's
 *   scope guard's `detect`).
 */
export async function limitContext(
  context: BrowserContext,
  profile: string,
  note: (entry: NetEntry) => void,
  visit?: (url: string) => void,
): Promise<void> {
  await context.addInitScript(NO_ROUTE_SCRIPT);
  const cancelled = (d: Download): void => {
    const url = d.url();
    note({
      profile,
      method: 'DOWNLOAD',
      url: downloadUrl(url),
      status: 0,
      requestBody: undefined,
      responseBody: 'cancelled: flowctl runs never save downloads',
      note: DOWNLOAD_NOTE,
    });
    if (/^https?:/i.test(url)) visit?.(url);
  };
  context.on('page', (page) => page.on('download', cancelled));
}
