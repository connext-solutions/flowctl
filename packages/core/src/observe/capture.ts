import { redactText, type Evidence } from '../run/index.js';
import { redactor } from './read-page.js';
import { PAGE_PATH, type AppCall, type AppPage } from './schema.js';

/** At most this many calls and console errors one page keeps (the `AppMap` caps). */
const MAX_CALLS = 500;
const MAX_ERRORS = 100;

const METHOD = /^[A-Z]{3,7}$/;

/** One page's share of what the run's evidence captured. */
export type PageCapture = Pick<AppPage, 'calls' | 'consoleErrors'>;

/**
 * Groups what the run's {@link Evidence} captures (fetch/xhr calls, console and page errors) per crawled page (task
 * T2.3): each {@link take} returns what arrived since the previous one, so the evidence, attached before the first
 * navigation (ADR 0010), also covers the start page `begin` opened.
 *
 * @remarks The redaction rules of run evidence apply (ADR 0030): a call keeps its method, path and status only (no
 *   origin, query or body), the path and each console line go through `redactText` with the run's secrets, so secret
 *   values and credential-looking pairs are `***`, and a line is cut to 300 characters. A call to another origin
 *   keeps that origin (never its query). Both lists are sorted and
 *   deduplicated, so the order in which calls answer does not change the map. Entries are grouped by when they
 *   arrived: a call that answers while the next page loads is counted on the next page.
 */
export class Capture {
  private calls = 0;
  private errors = 0;

  /** @param origin the map's origin: a call elsewhere keeps its origin, one here does not. */
  constructor(
    private readonly evidence: Evidence,
    private readonly secrets: readonly string[],
    private readonly origin: string,
  ) {}

  /** Whether the evidence stopped keeping console errors (its run-wide cap), so a page may miss some. */
  get cut(): boolean {
    return this.evidence.droppedConsoleErrors > 0;
  }

  /** Calls and console errors that arrived since the last call. */
  take(): PageCapture {
    const net = this.evidence.network.slice(this.calls);
    const lines = this.evidence.consoleErrors.slice(this.errors);
    this.calls += net.length;
    this.errors += lines.length;
    const calls = new Map<string, AppCall>();
    for (const e of net) {
      const call = this.call(e.method, e.url, e.status);
      if (e.note === undefined && call !== undefined)
        calls.set(
          `${call.origin ?? ''} ${call.path} ${call.method} ${call.status}`,
          call,
        );
    }
    return {
      calls: [...calls.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([, c]) => c)
        .slice(0, MAX_CALLS),
      consoleErrors: [...new Set(lines.map((l) => this.line(l)))]
        .sort()
        .slice(0, MAX_ERRORS),
    };
  }

  private call(
    method: string,
    url: string,
    status: number,
  ): AppCall | undefined {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return undefined;
    }
    const path = redactText(u.pathname, this.secrets);
    const m = method.toUpperCase();
    if (
      (u.protocol !== 'http:' && u.protocol !== 'https:') ||
      !PAGE_PATH.test(path) ||
      path.length > 2048 ||
      !METHOD.test(m)
    )
      return undefined;
    return u.origin === this.origin
      ? { method: m, path, status }
      : { method: m, path, status, origin: u.origin };
  }

  /** A console line without the evidence's `[profile] ` prefix, redacted again and cut to the map's 300 characters. */
  private line(text: string): string {
    return redactor(this.secrets)(text.replace(/^\[[a-z0-9-]+\] /, ''));
  }
}
