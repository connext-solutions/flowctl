import type { AppMap, AppPage } from '../schema.js';
import {
  CHECK_IDS,
  MAX_FINDINGS,
  type CheckFinding,
  type CheckId,
  type CheckResult,
  type FreeChecks,
} from './schema.js';

/** A finding before its `check`, `sourceRef` and `observation` are filled in: what was seen, and where in the map. */
type Seen = Omit<CheckFinding, 'check' | 'sourceRef' | 'observation'> & {
  pointer: string;
};

/** A check: every finding it reads from the map, in page order, then entry order. */
type Rule = (map: AppMap) => Seen[];

/** Whether a page's navigation got no answer that a guard does not explain: status 0, its own navigation not refused. */
const unanswered = (p: AppPage): boolean =>
  p.status === 0 && !p.navigationRefused;

/** The document status of page `p` (index `i` of the map) when it is in `[lo, hi]`. */
const documents =
  (lo: number, hi: number) =>
  (p: AppPage, i: number): Seen[] =>
    p.status >= lo && p.status <= hi
      ? [{ page: p.path, status: p.status, pointer: `/pages/${i}/status` }]
      : [];

/** The fetch/xhr call statuses of page `p` (index `i` of the map) in `[lo, hi]`. */
const calls =
  (lo: number, hi: number) =>
  (p: AppPage, i: number): Seen[] =>
    p.calls.flatMap((c, j) =>
      c.status >= lo && c.status <= hi
        ? [
            {
              page: p.path,
              status: c.status,
              call: {
                method: c.method,
                path: c.path,
                ...(c.origin === undefined ? {} : { origin: c.origin }),
              },
              pointer: `/pages/${i}/calls/${j}/status`,
            },
          ]
        : [],
    );

/** A rule from per-page readers: each page's findings in reader order, pages in map order. */
const perPage =
  (...readers: ((p: AppPage, i: number) => Seen[])[]): Rule =>
  (map) =>
    map.pages.flatMap((p, i) => readers.flatMap((read) => read(p, i)));

/**
 * Links whose target page is in the map and answered 4xx, 5xx or nothing ({@link unanswered}). A link to a page the
 * crawl did not open (out of scope, a decoy, past the budget) is not judged: nothing was observed about it.
 */
const brokenLinks: Rule = (map) => {
  const status = new Map<string, number>();
  for (const p of map.pages)
    if (p.status >= 400 || unanswered(p)) status.set(p.path, p.status);
  return map.pages.flatMap((p, i) =>
    p.links.flatMap((target, j) => {
      const s = status.get(target);
      return s === undefined
        ? []
        : [
            {
              page: p.path,
              target,
              status: s,
              pointer: `/pages/${i}/links/${j}`,
            },
          ];
    }),
  );
};

const RULES: Record<CheckId, Rule> = {
  'no-console-error': (map) =>
    map.pages.flatMap((p, i) =>
      p.consoleErrors.map((message, j) => ({
        page: p.path,
        message,
        pointer: `/pages/${i}/consoleErrors/${j}`,
      })),
    ),
  'no-4xx': perPage(documents(400, 499)),
  'no-5xx': perPage(documents(500, 599), calls(500, 599)),
  'no-broken-link': brokenLinks,
  'no-unreachable-page': (map) =>
    map.pages.flatMap((p, i) =>
      unanswered(p)
        ? [{ page: p.path, status: 0, pointer: `/pages/${i}/status` }]
        : [],
    ),
};

/** The result of one check: its findings, cut to {@link MAX_FINDINGS}, each with its `sourceRef` and map entry. */
function run(id: CheckId, map: AppMap): CheckResult {
  const seen = RULES[id](map);
  const findings = seen
    .slice(0, MAX_FINDINGS)
    .map(({ pointer, ...s }): CheckFinding => ({
      check: id,
      ...s,
      sourceRef: { kind: 'invariant', ref: id },
      observation: { kind: 'observation', file: 'appmap.json', pointer },
    }));
  return {
    id,
    status: seen.length === 0 ? 'passed' : 'failed',
    findings,
    omitted: seen.length - findings.length,
  };
}

/**
 * The free checks of a crawl (task T2.4): no console error, no 4xx (document statuses), no 5xx (document and
 * fetch/xhr call statuses), no broken link, no unreachable page. Pure and deterministic: no model, no browser, and no
 * expected value but the rule itself (ADR 0004); each finding copies what the map holds and points at that entry.
 *
 * @remarks A page with status 0 is unreachable only when the guards did not refuse its own navigation
 *   (`navigationRefused`): a navigation the scope guard or the crawl's request layer stopped (ADR 0033 decision 5) is
 *   an observation of the guard, not of the app. A late refusal of the page before, kept in `refused`, explains
 *   nothing. A 4xx fetch/xhr call is not judged: apps probe with expected 401, 404 or 422 answers, and no allow-list
 *   of expected statuses exists yet. A call with status 0 (aborted or refused) is not judged. A redirect is recorded
 *   under its final path, so a link to the first path of a redirect is not judged. 5xx call statuses are judged for
 *   every origin the page called.
 * @example
 * const { status, checks } = freeChecks(observation.map);
 * @see docs/adr/0033-read-only-crawl.md (amendment: free checks)
 */
export function freeChecks(map: AppMap): FreeChecks {
  const checks = CHECK_IDS.map((id) => run(id, map));
  return {
    v: 1,
    origin: map.origin,
    truncated: map.truncated,
    status: checks.some((c) => c.status === 'failed') ? 'failed' : 'passed',
    checks,
  };
}
