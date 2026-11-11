---
type: ADR
id: "0033"
title: "Observe crawls read-only and breadth-first; a page is a path; a refused request is an observation"
status: accepted
date: 2026-11-12
---

## Context

Observe (task T2.2) maps an app without a model: it visits pages and records what each one offers, so that later
stages can derive tests and run free checks (T2.4) from observations (ADR 0020). ADR 0024 says the crawl stays in
scope (section 3), that the destructive-action guard covers the crawler in every env class (section 5), and that
pages and time are budgeted (section 6). It does not say what a page is, in which order pages are visited, what the
crawler may activate, or what happens when the scope guard refuses a request during a crawl. For a replay or an
exploration, the first refusal ends the run (`scope_violation`, `destructive_blocked`), because a verdict must
never stand on a run that reached what it may not. A crawl gives no verdict, and on the test app one same-origin
link answers with a redirect to another origin: ending there would leave most apps unmappable.

## Decision

1. **A page is a path.** A page is identified by the path of its URL on the env's origin; the query string and the
   fragment are dropped, so what a query carries (filters, ids, tokens) never enters the map, and a hash route
   (`/map#/admin`) is the same page as `/map`, never opened as a route. A path segment can still carry a record id.
   A redirect inside the scope records the page under its final path, once; a page that moves itself to a path the
   crawl may not open (`pushState` to a denied path) is recorded under the path that was opened.
2. **Breadth-first, sorted.** The crawl starts at one path (the path of the env's `baseUrl`, or a given one), reads
   each page once, and queues the same-origin links it may follow in sorted order (UTF-16 code units), each path
   once. Pages are listed in visit order. The same app gives the same map, except `observedAt`.
3. **Read only.** The crawler navigates with `goto` and never clicks, types, scrolls or submits (submitting is the
   drive stage, T2.8). It follows a link only when the link opens in the same window (no `target=_blank`), is not a
   `download`, is in the `visit` scope (`inScope`), is not under the env's `loginUrl`, and neither its label nor its
   path holds a destructive word; a path is skipped when any link to it fails these rules. This label rule applies
   on every env class, `local` included (ADR 0024 section 5); on the test app it also skips "Phê duyệt", a link that
   only opens a list. Skipped links stay in the page's `links`.
4. **A read-only request layer on every env class.** The crawl's request layer (`RequestGuard.forCrawl`) refuses
   every method but `GET`, `HEAD` and `OPTIONS`, and every request the destructive matcher names, for the request
   types the guard judges (documents, fetch, XHR, beacons, event streams, `other`), on `local` too. The method is
   checked first and for every request type, so a `POST` of a type the guard does not otherwise judge (a CSP report)
   is refused too, while a `GET` script or image is not. Every WebSocket is closed before it connects, in scope or
   not: a frame sent on it could carry a write that no route sees. A page that writes on load is still mapped; its
   write never leaves the browser. A crawl never runs on an env the store classes
   `production` (`scope_violation` before any browser starts): ADR 0024 section 2a allows only `GET` there, on
   owner-signed path templates, which this layer does not check.
5. **A prevented refusal is an observation of its page.** During a crawl, a request the scope guard or the request
   layer stops before it is sent (the route aborts it, the redirect hold fails its hop, a popup's first hop is
   refused, a page check refuses a navigation before it starts) is aborted as in any run, but it does not end the
   run: its kind is recorded on the page that was open (`refused: ["scope_violation" | "destructive_blocked"]`), and
   the crawl goes on. A URL change that sends nothing (`pushState`, a hash route, a `data:` frame) counts the same way.
   A request the guards only detect after it was sent (a redirect hop no hold saw, a frame that moved to another
   origin, a download that got past the route) ends the crawl `scope_violation` or `destructive_blocked`, as in any
   run: what was sent cannot be taken back, so the map must not read as clean. A navigation refused before it is
   sent, or that does not answer, gives a page with status 0; a refused start page ends the run, since there is
   nothing to map from. Every other problem ends the crawl as it ends any run: an expired profile (the env's login
   page reached by a server redirect or by the page's own routing after it loaded), a page the guard could not hold
   (`internal`), the wall-clock budget.
6. **Budgets.** The page budget counts navigations: `target.budgets.pages`, at most the built-in ceiling (50). The
   wall-clock budget is the run's (`run/deadline.ts`); when it fires the run ends `budget_exceeded`. A page is given
   at most 2 s (`SETTLE_MS`, never more than `stepTimeout`) for its network to go quiet, so a page that polls costs
   2 s, not `stepTimeout`; a call it makes later is counted on the next page. Measured on the test app: the 5 pages of
   `/map` take 2.2 s; two pages that poll every 100 ms take about 4 s with `stepTimeout` 10 s (20 s before the cap). A crawl stopped
   by a budget, a list cut to its `AppMap` cap or an error has `truncated: true`. Cost is `unknown`: a crawl calls no
   driver.
7. **The result.** The map is validated against `AppMapSchema` and written to `appmap.json` in the run directory,
   beside `run.json`. Page text (titles, control and field names) and paths go through the evidence redaction (ADR
   0030); a call to another origin keeps that origin, so a refused third-party call never reads as a broken endpoint.
   A completed crawl's `run.json` says `passed` only because a run result has no other non-error status; it is not a
   verdict on the app (ADR 0004 still holds: there are no assertions, and verdicts from observations are the free
   checks', T2.4). The summary a caller gets (`observeSummary`, `flowctl observe --json`) has no `status` at all:
   `error` when the run ended in one, else nothing.

## Options considered

- **End the crawl at the first refusal, as every other run does.** Safe and simple, but one link that redirects out
  of scope stops the whole map. Rejected: the request is aborted either way; only the bookkeeping differs.
- **Keep the query in a page's identity.** Finds more states of a list, but stores ids and tokens and lets a crawl
  grow without bound on `?page=n`. Rejected; a later stage can add chosen query keys.
- **Follow `target=_blank` links in the same window.** Reaches more pages; but ADR 0024 lists popups among what the
  crawl does not open, and the test app uses one as a decoy. Rejected.
- **A new run status for a crawl (`observed`).** Clearest in `run.json`, but it changes the `RunResult` contract
  every caller branches on. Rejected for now; the summary leaves the status out instead.
- **Crawl production with the crawl's request layer.** It allows `HEAD`, `OPTIONS` and any query, where section 2a
  allows `GET` on signed templates only. Rejected until section 2a is built.
- **Skip the label rule on `local`.** Would map "Phê duyệt" on the test app; but a side-effecting GET wipes local
  data too, and ADR 0024 section 5 covers the crawler in every class. Rejected.

## Consequences

- **Easier:** a map is reproducible and safe to attach (paths only, no query, values or bodies, redacted text); a
  run on a `shared` env cannot write through a crawl; an app with one bad redirect is still mapped, with the refusal
  visible.
- **Harder:** pages behind a destructive-looking label, a query string or a popup are not visited; controls come
  from the snapshot, so only those in the first viewport are listed. A refusal or call that arrives while the next
  page loads is counted on the next page. An app that leaks one request past the hold (a later hop of a popup's
  redirect chain) cannot be mapped until that page is denied.
- **Not guarded:** the request layer reads the method and the path. A `GET` that changes data and whose path holds
  no destructive word (`GET /api/items/12/archive-now` with an unlisted word, `GET /sync`) is sent, and so is an
  action carried in the query (`?action=delete`, a GraphQL mutation in a `GET` query). Add the app's words to
  `target.destructiveWords`, or deny those paths in the scope, before crawling an env whose data matters.
- **Revisit when:** the drive stage (T2.8) needs form states, a stored confirmation (ADR 0024 section 5) should let
  a crawl open a reviewed destructive-looking link, or an app needs query keys to tell its pages apart.
