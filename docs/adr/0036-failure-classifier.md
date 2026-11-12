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
   | `error-kind` | the run errored with `app_unreachable`, `profile_expired`, `setup_failed`, `system1_unreachable`, `system1_not_allowed`, `env_not_trusted`, `env_not_allowed`, `hooks_untrusted` or `ledger_exists` | environment | high |
   | `error-kind` | the run errored with `budget_exceeded` (the wall-clock budget ran out; a slow or hanging app is also possible) | environment | low |
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
   flowctl. The classing of every error kind is one `Record` over `ErrorKind`, so a new kind does not typecheck
   until it is classed. A gateway status is only medium because a 504 can also be one slow endpoint of the app; a
   501 is not a gateway status and counts as a product bug (`server-error`). Step failures other than `not_found` on a role locator, and failed `value`, `network` and
   `noConsoleErrors` assertions, have no label or route rule; only the network rules can class them.
4. **Choosing, and ties.** The class is the class of the hits with the highest confidence. When hits of two or more
   classes share that confidence, the class is `unknown`, `confidence` is `null` and those hits are `candidates`;
   nothing picks one. The only precedence is the one in rule 3: an errored run is judged by its error kind and
   nothing else, because it never measured the app. No hit gives `unknown` with a note; there is no default class.
5. **What the rules compare.** The failing text `T` is the name of a role locator in a `not_found` step failure
   (`run.json` `failed.message`, as the browser's `notFoundMessage` writes it: `button "Gửi" not found`; a name may
   hold `"`) or the text of a failed
   `text` assertion. The expected path `E` is the literal path of a failed `url` assertion: an origin or leading `*`
   and trailing `*` dropped, nothing left that is `*`, `?`, `#` or a template; `A` is the path of `failed.got`. All
   text goes through `spec/text.ts`: `normText`, then `refusal` (a refused or empty text, or one over 300 code
   points, is not compared and gets a note); spec literals are `quotedSpans` of steps and expected items, and each
   item's `value`. The code index is asked through `findLabel`, `findMessage` and `findRoute`; the map is read as page
   titles (text assertions only) and the names of controls and form fields (for a locator, of its role only). A near
   text is `folded` when it equals `T` after the ADR 0034 case fold (`compareText`), else `contains` when one occurs
   in the other at token boundaries (`containsAtBoundaries`, the same answer as `occurrences` in linear time; both at
   least 2 code points); when any `folded` text exists the
   `contains` ones are not searched. The app has a text when the code index or the map states it exactly; a spec
   states a near text only when a literal equals it.
6. **Label scores.** `label-spec-drift`: 1, plus 1 when code and map both have `Y`, plus 1 when `Y` is `folded`.
   `label-stale`: 1 when the spec states `Y`, plus 1 when code and map both have it, plus 1 when it is `folded`.
   3 is high, 2 medium, less low; the near texts with the best score are the evidence.
7. **Route rules need the code index**, because "no route for `E`" must come from the index, and the map only says
   what the crawl reached. `route-spec-drift`: 2, plus 1 when code and map both have `A`. `route-stale`: 1, plus 1
   when the spec quotes `A`, plus 1 when code and map both have `A`. A spec literal names a path when it starts with
   `/`, cut at `?` or `#`. Paths of the map and the spec are compared after the normalisation `findRoute` applies
   (percent-decoded, no trailing `/`), so `/x/` and `/x` agree. A catch-all route (a pattern with a rest segment:
   `*`, `/*`, `:x*`, `**`) matches every path, so it never counts as the app having `E` or `A`; when one is left out
   the classification notes `catch-all route ignored`.
8. **Evidence.** Every hit cites what it used: a JSON Pointer into `run.json` (`/error/kind`, `/failed/message`,
   `/failed/assertion/url`, `/evidence/network/3`), a file and line of a code index record, a JSON Pointer into
   `appmap.json` (`/pages/2/controls/0/name`), or a JSON Pointer into the `Operation` with the item's `SpecRef` (a
   step cites the operation's document, `ref: null`).
9. **Untrusted text is data.** Page, spec and code strings are only compared, never interpreted. A compared string
   has at most 1,000 code points; evidence text is cut to 200 code points (ending with `…`); each text keeps at most 5
   evidence entries per source (code, map, spec, failed calls) and a failure at most 5 near texts. The `contains`
   search stops at the fifth distinct text, or when the code points it has read (each compared string's plus the
   failing text's) would pass 5,000,000 (`maxComparedPoints`), with the note `near search stopped at its budget`.
   Each comparison is linear in the two lengths, so the search costs at most that budget in code points, whatever
   the index holds.

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
  shows a message the spec forbids" is not a rule. The step locator is read from the message text of `run.json`; the
  executor and the classifier's tests build it with the same `notFoundMessage`, and a test pins its format. A locator
  is compared only with page controls of its role, so a button that became a link gives no near text from the map.
- **Revisit when:** the labelled corpus (T6.5) measures agreement with human labels below 80%, the
  run result carries the page URL of a failed step or the code location of a label, or spec items gain polarity;
  or triage shows control role changes (a button that became a link) are common enough to compare across roles.

## Amendment 2026-11-12: `flowctl reconcile <run id>` (task T6.6)

Decided under the owner's delegation of 2026-11-11; status of the body unchanged.

Decision 1 kept the classifier inside core. It now has a caller: `flowctl reconcile`, through the core entry point
`reconcileRun(cfg, runId, { code?, appmap?, spec? })` (`core/src/reconcile/project/`), exported from the package
with `reconcileGaps` (ADR 0037, amendment of the same date). The CLI parses, calls it and formats.

1. **Contract.** `flowctl reconcile <run id> [--code <dir>] [--appmap <file>] [--spec <dir>] [--json] [--config <path>]`.
   It prints the run, the class and the confidence, each `basis` hit (or each `candidates` hit on a tie) with its
   rule, class, confidence, `why` and evidence pointers (`run.json /failed/message`, `code <file>:<line>`,
   `appmap.json /pages/2/controls/0/name`, `spec <operation> <pointer> (<doc> line <n>)`), the other hits by name,
   the notes, and the file it wrote. Every string from the run, the code, the map or the spec goes through the CLI's
   `terminalSafe`. `--json` prints the core `Classification` unchanged, as written to the file.
2. **Exit codes.** `0` whenever it ran, whatever the class (a classification is advice, never a verdict, ADR 0004);
   `2` for a usage or configuration error (both or neither of a run id and `--gaps`, `--out` without `--gaps`, a run
   id that is not `r_` and 1 to 32 lowercase letters or digits, a missing or malformed `run.json`, a source outside
   its root, a file that is not an `AppMap`, a containment refusal from the code index or the spec provider); `3` for
   a trust refusal. Never `1`. The command is guarded (ADR 0025 section 3): it writes into the project's runs
   directory.
3. **Reading the run.** `run.json` is read from `<flowsDir>/.runs/<run id>/`, with no symlink on the way (the runs
   directory, the run directory, the file), at most 16 MiB, and parsed by a schema of the fields the classifier
   reads; a file whose `runId` is not the one named is refused. The run id is checked with the ledger's
   `RUN_ID_PATTERN` before it becomes a path.
4. **Writing.** The answer is written as `classification.json` into that run directory by `addRunArtefact`
   (`core/src/run/`), the only writer of a run directory besides `Evidence` and only for a finished run: the
   directory must exist and stay inside the flows directory, no component may be a symlink, and the file is written
   through a temporary file and a rename. Invisible and control code points are written as `\u` escapes, as
   `gaps.json` is (ADR 0037), so `--json` prints the same text.
5. **Roots.** `--code` opens a root of purpose `repos` and `--spec` one of purpose `specs` (ADR 0025 section 2). The
   store schema has `roots` entries of those purposes, but no command registers one yet (`trust add root` is
   reserved and refuses), so today the only containing root is the project root the store registers: a directory
   whose real path is outside it is refused (exit 2) and never read. When `trust add root` exists, a registered root
   of the matching purpose will be accepted too. The readers never enter dot folders (`.git`, `.flows`, `.auth`).
6. **The spec operation.** A run records no link to a spec. The classifier gets the markdown operation whose `id`
   equals the run's flow name exactly, and only when exactly one does; with none or several, it runs without spec
   and a note says so. No title, path or text similarity picks one. Spec documents the provider left out are counted
   in a note.
7. **The map and the origins.** A map is used only when `--appmap` names one (a file inside the flows directory, not
   under `.auth`, no symlink); none is picked by default, because a crawl of another env would change which origins
   count as the app's. The app's origins (decision 1, `origins`) are the origin of the run env's `baseUrl` in the
   config, plus the map's origin when a map is given, so `server-error` reaches medium without a map.

**Consequences.** A person can class a run from the terminal and attach `classification.json` to a triage note. A
code or spec folder outside the checkout cannot be used until `trust add root` exists. A flow named differently
from its spec operation is classified without spec.
