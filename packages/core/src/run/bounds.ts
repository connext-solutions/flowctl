/**
 * Size bounds for evidence text that reaches `run.json`, the CLI and the orchestrator (#57). Page and console
 * text is untrusted and unbounded: a polling page or a `console.error` loop must not grow a result past the
 * orchestrator budget (`.claude/rules/performance.md`, about 0.5 KB).
 *
 * @remarks Only the stored and shown text is bounded, never what the verifier counts: every fetch/xhr is still
 *   kept, so a `network` `absent` assertion cannot pass because an entry was dropped (ADR 0010), and
 *   `noConsoleErrors` still fails on a dropped error.
 */
import type { NetEntry } from './net-entry.js';

/** How many distinct requests {@link requestPaths} lists. */
export const MAX_SEEN_REQUESTS = 8;

/**
 * The distinct `METHOD /path` of the captured requests, most recent first and at most
 * {@link MAX_SEEN_REQUESTS}: no origin, query string or body (task H0.2). It tells the author of a `network`
 * assertion which path the app really called. A path can still carry record ids.
 */
export function requestPaths(net: readonly NetEntry[]): string[] {
  const seen = new Map<string, true>();
  for (const e of net) {
    let path: string;
    try {
      path = new URL(e.url).pathname;
    } catch {
      continue;
    }
    const key = `${e.method} ${path}`;
    seen.delete(key);
    seen.set(key, true);
  }
  return [...seen.keys()].reverse().slice(0, MAX_SEEN_REQUESTS);
}

/**
 * Console errors kept as text; later ones are only counted.
 *
 * @internal
 */
export const MAX_CONSOLE_ERRORS = 100;

/**
 * Characters kept of one console error, response body excerpt, or matching request in a `got`.
 *
 * @internal
 */
export const MAX_LINE = 300;

/**
 * Failed requests and console errors listed in the run summary (`evidence.network`, `evidence.console`).
 *
 * @internal
 */
export const MAX_SUMMARY_REQUESTS = 10;

/** Matching requests described in a `network` assertion's `got`, each clipped to {@link MAX_LINE}. */
export const MAX_GOT_HITS = 3;

/**
 * Error response bodies whose declared `content-length` is larger than this are not read for the excerpt.
 *
 * @remarks Playwright has no streaming read of a response body, so only a declared length can be checked; a body
 *   without the header (chunked) is still read whole before it is clipped.
 */
export const MAX_RESPONSE_READ = 1024 * 1024;

/** `text` cut to `n` characters, with `…` when something was cut. */
export const clip = (text: string, n: number = MAX_LINE): string =>
  text.length <= n ? text : `${text.slice(0, n)}…`;

/** The line that says how many console errors were counted but never kept, and where they still are. */
export const notKept = (n: number): string =>
  `… and ${n} more not kept (see trace-<profile>.zip)`;

/**
 * `items` cut to `n`, followed by `… and N more in <where>` when something was cut, and by {@link notKept}
 * when `dropped` more were seen but never kept.
 */
export function listed(
  items: string[],
  n: number,
  where: string,
  dropped = 0,
): string[] {
  const cut = Math.max(0, items.length - n);
  return [
    ...items.slice(0, n),
    ...(cut > 0 ? [`… and ${cut} more in ${where}`] : []),
    ...(dropped > 0 ? [notKept(dropped)] : []),
  ];
}
