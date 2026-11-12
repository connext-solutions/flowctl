---
type: ADR
id: "0037"
title: "Coverage gaps join code routes, crawled pages and spec operations by fixed rules, and say what may explain each gap"
status: accepted
date: 2026-11-12
---

Decided under the owner's delegation of 2026-11-11.

## Context

Reconcile (roadmap section 3.6) has three views of one app: the routes its code declares (the code index,
ADR 0035), the pages one read-only crawl saw (the `AppMap`, ADR 0033) and the operations its spec describes, joined
to the map by the matcher (ADR 0034). Where they do not meet is where tests are missing: a route nobody reached, a
screen the spec does not describe, an operation with no screen. A person reads this report to decide what to crawl,
write or ask next, so each gap must cite its evidence and must say when it may be an artefact of the inputs rather
than of the app.

## Decision

1. **A pure function.** `coverageGaps({ index?, map?, operations?, report? })` (`core/src/reconcile/gaps/`) has no
   model and no I/O. A kind of gap is checked only when its inputs are given, and the result lists the kinds it
   checked (`checked`): a kind not checked is not "no gap". Given `operations` and a map, it runs the matcher itself;
   given both `operations` and a `report`, or a report of another crawl (origin or time) than the map, it refuses
   (`ConfigError`).
2. **What counts as a gap**, reported in this order:
   - `route_unvisited` (index and map): a route record that no page path of the map matches. Each declaration is
     its own gap, with file, line, pattern and extractor;
   - `page_no_route` (index and map): a served page (document status 200 to 399) that no route matches, ignoring
     routes made only of rest segments (`*`, `/:slug*`): a catch-all is the app's "not found" page, not a
     declaration of that page;
   - `operation_no_ui` (report): an operation whose screen verdict is `none`;
   - `operation_ambiguous` (report): an operation whose screen verdict is `ambiguous`, with the tied pages;
   - `page_no_spec` (report and map): a served page that no operation's verdict names, as its screen or as one of a
     tie.
   Pages are cited by their path and a JSON Pointer into `appmap.json` (`/pages/3`), operations by id, title,
   provider, ref and their index in the report.
3. **Matching reuses the code index's rules.** A page path is turned into segments by the same function
   `findRoute` uses (`routeQuerySegments`: scope-path normalisation, NFC) and compared with each route's parsed
   pattern by `matchRoute` (parameters `:id`, Next.js `[id]` and Remix `$id` are already `:id` in the index,
   splats are rest segments, optional segments may be absent). Every route is compared with every page, so a
   route is never missed because a page matched more than 20 routes; the cost is bounded by the index and map caps
   (each `matchRoute` is linear in pattern and path length). No fuzzy or prefix match.
4. **Caveats instead of silence.** A gap carries `crawl_truncated` when the map is truncated and the gap could be
   one only because the crawl stopped (`route_unvisited`, `operation_no_ui`, `operation_ambiguous`: an unvisited
   page could have matched the route or out-scored the tie). It carries `paths_redacted` when a page path holds the
   redaction mask `***`, which can hide the literal segment a route or a quoted address names (`route_unvisited`
   when any page path is masked; a page gap when its own path is). Paths are used as the map holds them, never
   unmasked: a masked segment matches only a parameter.
5. **Deterministic.** Gaps are ordered by kind as above; routes by path, file, line and extractor; pages by path;
   operations in report order (by id, provider and ref, ADR 0034 rule 9). Strings compare by UTF-16 code units.
6. **Files.** `writeGaps(dir, root, gaps)` checks the gaps against `CoverageGapsSchema` and writes `gaps.json` and
   `gaps.md` inside `root` (`ensureDirInside`, no symlinks), as `writeConflicts` does. The JSON escapes invisible
   and control code points (`hideInvisible`); in the markdown every string from the code, the map or the spec is
   one code span (`mdCode`, ADR 0034 rule 10), in list entries, never table cells.

**What is not a gap.** A page with an error or no document status (a free-check finding, ADR 0033); a page whose
path the normalisation refuses (it cannot be compared); a catch-all route once any page was crawled (every path
matches it); an operation matched to one screen, however weakly; a step or label the screen lacks (a conflict,
ADR 0034, not a coverage gap).

## Options considered

- **Use `findRoute` per page.** One normalisation and one matcher, already tested, but its answer is capped at 20
  routes, so a page with many matching patterns could leave a route falsely unvisited. Rejected for the scan;
  the path function it uses is shared instead.
- **Drop gaps on a truncated crawl.** Safe, but a large app is always crawled under a budget, and the report would
  then say nothing. Rejected: the caveat lets a person decide.
- **Count a catch-all route as declaring every page.** Then `page_no_route` is always empty in an app with a "not
  found" route. Rejected.
- **Count only `matched` screens as claimed.** Then every page of a tie is also reported as undescribed, twice the
  noise for one question (`operation_ambiguous` already names them). Rejected.

## Consequences

- **Easier:** a person sees, with file and line or map pointer, which routes to crawl, which screens the spec does
  not describe, and which operations have no screen yet; the caveats say when the crawl budget or a mask may explain
  a gap.
- **Harder:** the code index is a lexer (ADR 0035): a computed route path is not indexed, so its pages show as
  `page_no_route`. A route reached only with a query or a hash route is invisible to a crawl that keys pages by path.
- **Revisit when:** the classifier (T6.2) needs gaps per component, the crawl records routes visited by actions
  (T2.8), or measured reports show the catch-all rule hiding real routes.
