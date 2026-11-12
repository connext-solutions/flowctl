---
type: ADR
id: "0036"
title: "The failure classifier applies fixed rules with cited evidence, and reports a tie instead of breaking it"
status: accepted
date: 2026-11-12
---

> Decided under the owner's delegation of 2026-11-11.

## Context

Reconcile (roadmap section 3.6) has to say, for a run that failed or errored, what most likely went wrong: a
product bug, a spec that the code no longer follows (spec drift), a test whose label or route moved (stale test), or
an infrastructure problem (environment). A person triages this today by reading `run.json`, the trace, the spec and
the code. The code index (ADR 0035) gives routes, i18n labels and validator messages with file and line; the crawl
gives an `AppMap` (ADR 0033); a spec provider gives `Operation`s with a `SpecRef` per expected item (ADR 0023).

A classification is read by a person who decides what to do. If it is a guess, or if it depends on a model, the
person cannot check it and stops trusting it. If it changes a verdict, it breaks ADR 0004. The inputs are untrusted:
page text, spec text and code strings come from outside flowctl.

## Decision

1. **Scope.** `classifyFailure(input, limits?)` in `core/src/reconcile/classify/` takes one `RunResult` and, as
   options, a `CodeIndex`, an `AppMap`, one spec `Operation` and the app's own origins (default: the map's origin).
   It returns a `Classification`: `class` (`product_bug`, `spec_drift`, `stale_test`, `environment` or `unknown`),
   `confidence` (`high`, `medium`, `low`, or `null` for `unknown`), `basis` (the rule hits it stands on),
   `candidates` (only on a tie), `hits` (every rule that fired, in rule order) and `notes` (fixed sentences about
   inputs no rule could use). Exported from `reconcile/index.ts`, not from the package yet.
2. **Pure and advisory.** No model, no network, no file system, no clock: the same input gives the same answer. The
   classification never changes a verdict and is not a verdict (ADR 0004); a passed run is `unknown`.
3. **Fixed rules in a fixed order.** The rules run in the order of `RULE_IDS`. An errored run is judged by rule 1
   alone; a failed run by the others. Each hit carries a fixed sentence (`why`) and its evidence.

   | Rule | Fires when | Class | Confidence |
   |---|---|---|---|
   | `error-kind` | the run errored with `app_unreachable`, `profile_expired`, `setup_failed`, `system1_unreachable`, `system1_not_allowed`, `budget_exceeded`, `env_not_trusted`, `env_not_allowed`, `hooks_untrusted` or `ledger_exists` | environment | high |
   | `gateway-status` | a failed call in `evidence.network` got 502, 503 or 504 | environment | medium |
   | `no-response` | a failed call got status 0 | environment | low |
   | `server-error` | a failed call to one of the app's origins got another 5xx | product_bug | medium (low when no origin is known) |
   | `foreign-server-error` | a failed call to another origin got another 5xx | environment | low |
   | `label-spec-drift` | the spec states the failing text `T`, the app does not, the app has a near text `Y` the spec does not state | spec_drift | score, rule 6 |
   | `label-stale` | neither the spec nor the app states `T`, the app has a near `Y` | stale_test | score, rule 6 |
   | `label-product-bug` | the spec and the code index both state `T` exactly | product_bug | medium |
   | `route-spec-drift` | the spec quotes the expected path `E`, the app has no `E`, the app has the page's path `A` | spec_drift | score, rule 7 |
   | `route-stale` | the spec does not quote `E`, the app has no `E`, the app has `A` | stale_test | score, rule 7 |
   | `route-product-bug` | the spec quotes `E` and the code index has a route for it | product_bug | medium |

   The other error kinds (`flow_invalid`, `scope_violation`, `destructive_blocked`, `ledger_replay`,
   `ledger_mismatch`, `ledger_overflow`, `internal`) are not classed: each can come from the app, the flow or
   flowctl. Step failures other than `not_found` on a role locator, and failed `value`, `network` and
   `noConsoleErrors` assertions, have no label or route rule; only the network rules can class them.
4. **Choosing, and ties.** The class is the class of the hits with the highest confidence. When hits of two or more
   classes share that confidence, the class is `unknown`, `confidence` is `null` and those hits are `candidates`;
   nothing picks one. The only precedence is the one in rule 3: an errored run is judged by its error kind and
   nothing else, because it never measured the app. No hit gives `unknown` with a note; there is no default class.
5. **What the rules compare.** The failing text `T` is the name of a role locator in a `not_found` step failure
   (`run.json` `failed.message`, as `describeLoc` prints it: `button "Gửi" not found`) or the text of a failed
   `text` assertion. The expected path `E` is the literal path of a failed `url` assertion: an origin or leading `*`
   and trailing `*` dropped, nothing left that is `*`, `?`, `#` or a template; `A` is the path of `failed.got`. All
   text goes through `spec/text.ts`: `normText`, then `refusal` (a refused or empty text, or one over 300 code
   points, is not compared and gets a note); spec literals are `quotedSpans` of steps and expected items, and each
   item's `value`. The code index is asked through `findLabel`, `findMessage` and `findRoute`; the map is read as page
   titles (text assertions only) and the names of controls and form fields (for a locator, of its role only). A near
   text is `folded` when it equals `T` after the ADR 0034 case fold (`compareText`), else `contains` when one occurs
   in the other at token boundaries (`occurrences`, both at least 2 code points); when any `folded` text exists the
   `contains` ones are not searched. The app has a text when the code index or the map states it exactly; a spec
   states a near text only when a literal equals it.
6. **Label scores.** `label-spec-drift`: 1, plus 1 when code and map both have `Y`, plus 1 when `Y` is `folded`.
   `label-stale`: 1 when the spec states `Y`, plus 1 when code and map both have it, plus 1 when it is `folded`.
   3 is high, 2 medium, less low; the near texts with the best score are the evidence.
7. **Route rules need the code index**, because "no route for `E`" must come from the index, and the map only says
   what the crawl reached. `route-spec-drift`: 2, plus 1 when code and map both have `A`. `route-stale`: 1, plus 1
   when the spec quotes `A`, plus 1 when code and map both have `A`. A spec literal names a path when it starts with
   `/`, cut at `?` or `#`.
8. **Evidence.** Every hit cites what it used: a JSON Pointer into `run.json` (`/error/kind`, `/failed/message`,
   `/failed/assertion/url`, `/evidence/network/3`), a file and line of a code index record, a JSON Pointer into
   `appmap.json` (`/pages/2/controls/0/name`), or a JSON Pointer into the `Operation` with the item's `SpecRef` (a
   step cites the operation's document, `ref: null`).
9. **Untrusted text is data.** Page, spec and code strings are only compared, never interpreted. A compared string
   has at most 1,000 code points; evidence text is cut to 200 code points (ending with `…`); each text keeps at most 5
   evidence entries per source (code, map, spec, failed calls) and a failure at most 5 near texts; the `contains` search stops at the fifth distinct text, so a
   hostile index of long labels costs one native substring scan per label.

## Options considered

- **Fixed rules with evidence** (chosen): every answer can be checked by following its pointers; the rules are few
  and listed here; a tie says so.
- **A model reads the trace and the code and names the class.** Handles any failure, but the answer cannot be
  reproduced or checked, and it would put model judgement next to the verdict. Rejected; a model may later propose a
  class for `unknown` cases, recorded as such and never as `basis`.
- **Edit distance between the failing text and code labels** as the near rule. Finds rewordings that the fold and
  token containment miss, but the threshold becomes a tuning knob and `Gửi` is as close to the wrong button as to the
  right one (ADR 0034). Rejected for now; the labelled corpus (T6.5) measures whether it is needed.
- **Break ties by a class precedence** (environment before product bug before spec drift before stale test). Always
  gives an answer, but the answer then reflects the order, not the evidence. Rejected, except for errored runs
  (rule 4), where no other rule can have evidence about the app.
- **Classify from the previous code location of a label** (the label was at file A line 10 and is now at file B).
  The flow does not record where its labels were in the code, so there is no "before" to compare; deferred until a
  flow or an approval record carries code locations.

## Consequences

- **Easier:** a person gets a class, how sure it is, and pointers they can open; a report (T7.10) can print the
  table; `unknown` with `candidates` shows exactly which two readings compete.
- **Harder:** a reworded label (`Lưu` → `Ghi lại`) gives no near text and stays `unknown`. A message rendered from
  a key the index does not join to a label, a label in JSX text, and a computed route path are not in the index
  (ADR 0035), so "the app has no `E`" can be wrong; that is why the highest route and label scores need the map too.
  A spec item cannot say that a message must not appear (ADR 0023: the item carries no polarity), so "the page
  shows a message the spec forbids" is not a rule. The step locator is read from the message text of `run.json`; a
  change of `describeLoc` must change `subjectOf` with it (the tests pin the format).
- **Revisit when:** the labelled corpus (T6.5) measures agreement with human labels below 80%, the
  run result carries the page URL of a failed step or the code location of a label, or spec items gain polarity.
