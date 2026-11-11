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
   fragment are dropped, so record ids and tokens never enter the map and a hash route (`/map#/admin`) is the same
   page as `/map`, never opened as a route. A redirect inside the scope records the page under its final path, once.
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
   types the guard judges (documents, fetch, XHR, beacons, event streams, `other`), on `local` too. A page that
   writes on load is still mapped; its write never leaves the browser.
5. **A refusal is an observation of its page.** During a crawl, a request the scope guard or the request layer
   refuses is aborted as in any run, but it does not end the run: its kind is recorded on the page that was open
   (`refused: ["scope_violation" | "destructive_blocked"]`), and the crawl goes on. A navigation that is refused or
   does not answer gives a page with status 0. Every other problem ends the crawl as it ends any run: an expired
   profile, a page the guard could not hold (`internal`), the wall-clock budget.
6. **Budgets.** The page budget counts navigations: `target.budgets.pages`, at most the built-in ceiling (50). The
   wall-clock budget is the run's (`run/deadline.ts`); when it fires the run ends `budget_exceeded`. A crawl stopped
   by a budget, a list cut to its `AppMap` cap or an error has `truncated: true`. Cost is `unknown`: a crawl calls no
   driver.
7. **The result.** The map is validated against `AppMapSchema` and written to `appmap.json` in the run directory,
   beside `run.json`. A completed crawl's `run.json` says `passed`: the crawl finished. It is not a verdict on the
   app; there are no assertions, and verdicts from observations are the free checks' (T2.4).

## Options considered

- **End the crawl at the first refusal, as every other run does.** Safe and simple, but one link that redirects out
  of scope stops the whole map. Rejected: the request is aborted either way; only the bookkeeping differs.
- **Keep the query in a page's identity.** Finds more states of a list, but stores ids and tokens and lets a crawl
  grow without bound on `?page=n`. Rejected; a later stage can add chosen query keys.
- **Follow `target=_blank` links in the same window.** Reaches more pages; but ADR 0024 lists popups among what the
  crawl does not open, and the test app uses one as a decoy. Rejected.
- **Skip the label rule on `local`.** Would map "Phê duyệt" on the test app; but a side-effecting GET wipes local
  data too, and ADR 0024 section 5 covers the crawler in every class. Rejected.

## Consequences

- **Easier:** a map is reproducible and safe to attach (paths only, no values, no bodies); a run on a `shared` env
  cannot write through a crawl; an app with one bad redirect is still mapped, with the refusal visible.
- **Harder:** pages behind a destructive-looking label, a query string or a popup are not visited; controls come
  from the snapshot, so only those in the first viewport are listed. A refusal or call that arrives while the next
  page loads is counted on the next page.
- **Revisit when:** the drive stage (T2.8) needs form states, a stored confirmation (ADR 0024 section 5) should let
  a crawl open a reviewed destructive-looking link, or an app needs query keys to tell its pages apart.
