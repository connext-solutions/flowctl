import type { APIResponse, CDPSession, Frame, Page, Route } from 'playwright';
import type { ScopeKind } from '../browser/index.js';
import { errorMessage } from './outcome.js';

/** The statuses a browser follows as a redirect hop (`Location`); 300 and 304 are not followed. */
const REDIRECT = new Set([301, 302, 303, 307, 308]);

/**
 * Decides whether a request of resource `type` sending `method url` may be reached as `kind`, noting a violation when
 * not (the guard's judge).
 */
export type Judge = (
  url: string,
  kind: ScopeKind,
  method: string,
  type: string,
) => boolean;

/**
 * The method a browser uses for the hop of a redirect answer to a `method` request: 307 and 308 keep it, 303 turns
 * anything but `HEAD` into `GET`, 301 and 302 turn `POST` into `GET` (WHATWG fetch, "HTTP-redirect fetch").
 */
export function hopMethod(status: number, method: string): string {
  const m = method.toUpperCase();
  if (status === 307 || status === 308) return m;
  if (status === 303) return m === 'HEAD' ? 'HEAD' : 'GET';
  return m === 'POST' ? 'GET' : m;
}

/** One response paused at the response stage, the part of `Fetch.requestPaused` the hold reads. */
interface Paused {
  requestId: string;
  resourceType: string;
  request: { url: string; method: string };
  responseStatusCode?: number;
  responseErrorReason?: string;
  responseHeaders?: { name: string; value: string }[];
}

/**
 * The absolute URL a redirect answer sends the browser to, or `undefined` when the answer is not a followed redirect.
 * A `Location` that does not resolve is returned as written, so the judge refuses it.
 *
 * @param base the URL of the request the answer is for.
 */
export function hopTarget(
  status: number | undefined,
  location: string | undefined,
  base: string,
): string | undefined {
  if (!REDIRECT.has(status ?? 0) || location === undefined) return undefined;
  try {
    return new URL(location, base).href;
  } catch {
    return location;
  }
}

const locationOf = (p: Paused): string | undefined =>
  p.responseHeaders?.find((h) => h.name.toLowerCase() === 'location')?.value;

/** Whether `p` is paused before it was sent (the request stage), not on its answer. */
const atRequest = (p: Paused): boolean =>
  p.responseStatusCode === undefined && p.responseErrorReason === undefined;

/**
 * Holds every response of `page`'s frames at the response stage (CDP `Fetch`, request stage left to Playwright's
 * route) and fails a redirect answer whose `Location` the judge refuses, so the browser never sends the hop
 * (ADR 0024 section 3, "at every redirect hop"). Any other answer goes on unchanged. Document requests are also
 * held at the request stage: a `download` link on the page's own origin reaches no Playwright route, so it is
 * judged here and failed before it is sent when the judge refuses it (rule 6).
 *
 * @param frame a cross-site frame in its own process to hold instead of the page's own target (see `run/frames.ts`).
 * @remarks Chromium only (flowctl launches Chromium). It covers the page's main frame and its same-process frames;
 *   a cross-site frame (its own process) is held only when `frame` names it, and a worker runs in its own target,
 *   where the context route still stops the request and the guard's `request` listener still detects a hop. Every
 *   response and every document request waits one local CDP round trip. A `continueRequest` or `failRequest` that
 *   fails is dropped on purpose: it fails when the request is
 *   already gone (the page aborted it, a navigation dropped it, the page closed), and a request that is gone sends
 *   no hop, so it is neither a violation nor an error. The target is judged without a fragment (CDP request URLs
 *   carry none), so a denied hash route reached through a redirect is caught by the guard's `watch`, after the fact.
 * @throws {Error} from Playwright when no CDP session can be opened on `page` or `frame` (not Chromium, page closed,
 *   a frame that shares its parent's process).
 * @see docs/adr/0024-target-scope-and-guards.md
 */
export async function holdRedirects(
  page: Page,
  judge: Judge,
  frame?: Frame,
): Promise<void> {
  const cdp: CDPSession = await page.context().newCDPSession(frame ?? page);
  cdp.on('Fetch.requestPaused', (p) => {
    const sending = atRequest(p);
    const target = sending
      ? p.request.url
      : hopTarget(p.responseStatusCode, locationOf(p), p.request.url);
    const kind: ScopeKind = p.resourceType === 'Document' ? 'visit' : 'call';
    const method = sending
      ? p.request.method
      : hopMethod(p.responseStatusCode ?? 0, p.request.method);
    const sent =
      target !== undefined && !judge(target, kind, method, p.resourceType)
        ? cdp.send('Fetch.failRequest', {
            requestId: p.requestId,
            errorReason: 'BlockedByClient',
          })
        : cdp.send('Fetch.continueRequest', { requestId: p.requestId });
    sent.catch(() => undefined);
  });
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
      { urlPattern: '*', requestStage: 'Response' },
    ],
  });
}

/**
 * Answers a navigation that has no page yet (a popup's first request, see `ScopeGuard`) after judging its first
 * redirect hop: the answer is fetched without following redirects, a `Location` the judge refuses aborts the request,
 * any other answer is handed to the browser as it came.
 *
 * @param fail notes why the answer could not be fetched; the request is aborted as the browser would fail it.
 * @remarks Only the first hop is prevented: the browser follows a handed-over redirect without routing it, so a
 *   second hop of that chain is held only if the popup's hold is attached by then, and is otherwise detected by the
 *   guard's `request` listener. The request is sent from Node (Playwright's `route.fetch`), not from the browser:
 *   the body is buffered whole and Playwright's request timeout applies, so a popup that streams a large export may
 *   behave differently from a plain browser. Answering a route whose popup already closed rejects; that answer is
 *   dropped, since a closed popup loads nothing.
 */
export async function answerFirstHop(
  route: Route,
  judge: Judge,
  fail: (why: string) => void,
): Promise<void> {
  const r = route.request();
  let answer: APIResponse;
  try {
    answer = await route.fetch({ maxRedirects: 0 });
  } catch (e) {
    fail(`the first answer of ${r.url().slice(0, 200)}: ${errorMessage(e)}`);
    return route.abort('failed').catch(() => undefined);
  }
  const target = hopTarget(answer.status(), answer.headers().location, r.url());
  const sent =
    target !== undefined &&
    !judge(target, 'visit', hopMethod(answer.status(), r.method()), 'document')
      ? route.abort('blockedbyclient')
      : route.fulfill({ response: answer });
  return sent.catch(() => undefined);
}
