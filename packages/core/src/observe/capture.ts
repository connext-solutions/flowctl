import { MAX_LINE, redactText, type Evidence } from '../run/index.js';
import type { AppCall, AppPage } from './schema.js';

/** At most this many calls and console errors one page keeps (the `AppMap` caps). */
const MAX_CALLS = 500;
const MAX_ERRORS = 100;

const PATH = /^\/(?!\/)[^?#\s]*$/;
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
 *   values and credential-looking pairs are `***`, and a line is cut to 300 characters. Both lists are sorted and
 *   deduplicated, so the order in which calls answer does not change the map. Entries are grouped by when they
 *   arrived: a call that answers while the next page loads is counted on the next page.
 */
export class Capture {
  private calls = 0;
  private errors = 0;

  constructor(
    private readonly evidence: Evidence,
    private readonly secrets: readonly string[],
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
        calls.set(`${call.path} ${call.method} ${call.status}`, call);
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
    let path: string;
    try {
      path = redactText(new URL(url).pathname, this.secrets);
    } catch {
      return undefined;
    }
    const m = method.toUpperCase();
    return PATH.test(path) && path.length <= 2048 && METHOD.test(m)
      ? { method: m, path, status }
      : undefined;
  }

  /** A console line without the evidence's `[profile] ` prefix, redacted again and cut to the map's 300 characters. */
  private line(text: string): string {
    const bare = text.replace(/^\[[a-z0-9-]+\] /, '');
    const red = redactText(bare, this.secrets);
    return red.length <= MAX_LINE ? red : `${red.slice(0, MAX_LINE - 1)}…`;
  }
}
