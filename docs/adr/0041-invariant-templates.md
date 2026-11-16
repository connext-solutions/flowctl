---
type: ADR
id: "0041"
title: "Invariants are templates with a fixed expansion: they bind to evidence, judge what was observed and expand only where the assertion catches the template's own seeded bug"
status: proposed
date: 2026-11-16
---

## Context

ADR 0020 section c lets a generated assertion cite an `invariant`: a rule that holds for any app (a created record
appears, a reload keeps it, no 5xx, no console error). The expected value is the rule, so nothing is read from a run
and nothing is invented. Section d adds that the assertion must equal what the template expands to, which is how
`check` and the case approval know an invariant assertion was not edited.

Task T4.9 builds the ten templates. Three facts shape the design. The flow assertion schema has no "text is absent" and
no status class: `network.status` is one exact integer and `text` only says what is present. The drive stage (T2.8)
that records what a click sent and what the page showed after a reload does not exist yet. The two free checks
(`no-5xx`, `no-console-error`) already exist in `observe/checks` and must not get a second implementation. And an
assertion that parses is not one that catches its defect: an unbounded `text` passes on a toast that repeats the
value, and a `text` written after a create passes whether or not a reload keeps the record.

## Decision

1. **A template has four parts.** `core/src/derive/invariants/` (layer `derive`, not exported from the package) holds
   `INVARIANTS`, one `InvariantTemplate` per id in `INVARIANT_IDS`: `crud-create-appears`, `crud-edit-shows`,
   `crud-delete-absent`, `reload-keeps-data`, `no-5xx`, `no-console-error`, `round-trip-equality`,
   `state-change-after-action`, `success-toast-implies-2xx`, `client-blocks-what-server-rejects`.
   - `params`: a strict zod schema. Fields are paths, controls (role and name), an optional `within` locator or
     `valueFrom: <input name>`, where the name is a flow name (`NAME_PATTERN`). No free text, no status class, no
     `absent` flag, no ref (ADR 0020 section c). An unknown key is a refusal.
   - `bind(evidence, params)`: ties every parameter to evidence and returns a `Refusal` (`no_evidence`, `bad_input`,
     `bad_params`, each with a fixed sentence, never page text) when the page is not in the map, the drive has no step
     of that kind, or the value input is not an own `{ value }` input of the flow holding a `QA-` value made unique by
     `{{uid}}`. No parameter is free: `valueFrom` binds only steps whose `sent` the input's template writes (its text
     literal, each `{{uid}}` one run of 1 to 8 lowercase hex digits), and a `within` must name (role and name, no test
     id) a region or a control the map records on that page.
   - **No vacuous pass (ADR 0020 section g).** `crud-delete-absent` binds only a delete whose item was listed before
     and whose click sent a request; `client-blocks-what-server-rejects` binds only a probe that sent a request or
     whose client blocked. Anything else refuses `no_evidence`, since "not listed after" or "nothing sent" would pass
     without testing anything.
   - `evaluate(evidence, params)`: the observation-time verdict. Findings carry a `sourceRef`
     `{ kind: 'invariant', ref: <id> }` and an `observation` JSON Pointer into `appmap.json` or `drive.json`. A refusal
     is not a pass.
   - `expand(evidence, params)`: the whole assertion, with its `sourceRef` added by the library (`kind` and `ref`
     only, no quote, no revision), or `not_expandable` with a sentence.
2. **`invariantResolves(assertion, params, evidence)` is whole equality.** It reads the template from
   `assertion.sourceRef.ref`, expands it for the same parameters and evidence and demands their `canonicalJson`
   (`trust/`, the form signatures are computed over) is equal; a value with no canonical form fails closed
   (`not_canonical`). So an edited text, a changed or dropped `within`, a quote in the `sourceRef`, a ref that names
   no template, parameters the template does not define or evidence that no longer holds the step all fail closed.
   This is the unit T4.5 signs and T4.3 and `check` call. The ref is what the case claims, and each template must bind
   on its own evidence.
3. **Evidence is the map plus a drive record.** `InvariantEvidence` is `{ map, drive?, inputs }`. `DriveRecord` is a
   strict schema of steps (action, page, control, field, the value sent, the request and its status or `null`, whether
   the control was visible and enabled right before the action (`actionable`, ADR 0020 amendment 2026-11-12 section
   4), whether the request window closed after it (`settled`: nothing in flight and no fetch or XHR started for
   1000 ms, section 3), whether the client blocked, the page state before, after and after a reload, the value read
   back, the status text). `clientBlocked` is accepted only with `actionable`, `settled` and no request, so "the
   client blocked" is never read off a click that did not happen or a window still open. Every text is bounded and
   free of control and invisible code points, every value written starts with `QA-`, and no expected value is read
   from a run. T2.8 must emit this shape, or the schema moves to `observe/` and is imported; until then the tests
   build it with a drive written for them (`test/derive/invariants-drive.ts`, which waits on Playwright events, never
   a timed poll).
   The map records each page's named regions (`regions`: a visible `list`, `table`, `grid` or `region` with an
   `aria-label` or `aria-labelledby` name, read by the crawl's page script like a form name; optional, so older maps
   still parse). That is the evidence a `within` binds to.
4. **The free checks are wrapped.** `no-5xx` and `no-console-error` call `freeChecks(map)` and pick the check of the
   same id, so a verdict cannot differ from `flowctl observe`. A case made only of free invariants is smoke-only
   (`isSmokeOnly`).
5. **Evaluate is always available; expand only where the assertion catches the template's own seeded bug.** An
   expansion must fail its seeded mode, pass the clean app, and the same flow without it must pass the seeded mode;
   `invariants-expand.accuracy.test.ts` replays each one that way. No expected value is read from a run: an expansion
   holds only the rule and the input's template text. An exact status observed in a run would be a `baseline`
   (ADR 0020 section f), never an invariant expansion. This decision does not widen the assertion schema.
   Expandable today:
   - `crud-create-appears` and `crud-edit-shows`: `text` with the input's template text (for example `QA-{{uid}}`,
     copied because ADR 0026 has no input reference inside an assertion), held `within` a list region the map records
     on that page. Without such a region the expansion refuses `no_evidence`: the status line repeats the value after a
     create or an edit, so an unbounded `text` passes on the toast alone.
   - `no-console-error`: `noConsoleErrors`.

   Not expandable (`not_expandable` with the reason in the template; `evaluate` still judges them):
   - `no-5xx`: a status class; `network.status` is one exact integer.
   - `crud-delete-absent`: text absence; `text` only says what is present.
   - `state-change-after-action`: a comparison of two observations.
   - `reload-keeps-data`: a flow assertion cannot force the reload it needs, and a `text` after the write also passes
     on the list drawn before any reload.
   - `round-trip-equality`: a `value` assertion reads the field the flow typed into; the flow schema cannot read the
     value back from a fresh load.
   - `success-toast-implies-2xx`: no assertion kind ties a toast to the status of the request that caused it.
   - `client-blocks-what-server-rejects`: a blocked client is `network … absent: true`, and no evidence holds the URL
     the blocked form would send to, so the pattern ADR 0020 section g needs would be chosen, not bound.

   Such a case stays an observation or smoke-only until a flow-schema task adds the kind with its own seeded bug.
6. **Each invariant has a seeded bug, and each bug is caught by exactly one invariant.** fixture-app gets
   `INVARIANT_BUG_MODES` on the `/items` app, kept out of `BUG_MODES` because no flow assertion catches them:
   `createNotListed`, `editNotShown`, `deleteStillListed`, `reloadLosesData`, `readBackAltered`, `itemApproveNoop`,
   `toastOnConflict`, `clientLimitMissing`. The free invariants reuse the crawl modes `page500`, `call500` and
   `pageConsoleError`. The mode is fixed per fixture start; `reset()` clears the data, never the mode.
   `invariants.accuracy.test.ts` pins one invariant per mode, written from the defect, and the clean app finds
   nothing. T4.7 counts from that table, so it stays stable.

## Options considered

- **Wait for T2.8.** Rejected: the templates need a settled evidence shape to be tested at all, and a stub of the drive
  runtime would be thrown away. Defining the record here and requiring T2.8 to match it costs one schema.
- **Widen the assertion schema now (`textAbsent`, `statusClass`).** Rejected: a new assertion kind needs its own seeded
  bug, verifier change and ADR (extend-engine). Marking seven templates `not_expandable` keeps this task inside its
  paths and loses no verdict, since `evaluate` still judges them.
- **Keep the expansions that write a valid assertion (`text` for a reload, `value` for a round trip, the observed
  status for a toast).** Rejected: each passed its own seeded mode, so a derived case would be green on the defect it
  claims to check; the toast one also copied an expected status from a run.
- **Hold the CRUD `text` within a control, or leave `within` optional.** Rejected: a control holds no list text, and
  an unbounded `text` passes on the status line.
- **Re-implement the free checks as templates.** Rejected: two implementations drift. Wrapping gives one set of
  findings.
- **Let an input reference appear inside assertions.** Rejected: the template text is copied and both expand to the
  same value at run time. An input-reference syntax would be its own decision.

## Consequences

### Easier

- T4.3 builds a case from templates and calls `invariantResolves` to keep an edited assertion out; T4.5 signs that
  equality.
- A new invariant is one template file, a row in `INVARIANTS`, a case in the unit tests and a seeded mode with a row in
  the accuracy matrix.

### Harder

- Seven of ten templates produce no flow assertion yet, so a derived case holds them only as observations.
- `AppMap` pages gain an optional `regions` list; the crawl reads it with the forms, and a CRUD expansion needs the app
  to name its list (`aria-label`), as `/items` now does ("Danh sách mục").
- The drive record is a contract with T2.8; a change to it after T4.3 starts is rework.
- `/items` is shared with the run ledger tests: its page changed (rows now hold a state, a rename field and two
  buttons, a name over 40 characters is blocked and the list is named), and a mode defaults off, is fixed per fixture
  start, and `reset()` clears the data, never the mode.

### Revisit when

- T2.8 lands: replace the test drive with the real stage and move `DriveRecord` if it differs.
- A flow-schema task adds a status class, text absence, a read-back after a forced reload or a toast tied to a
  status: make the matching templates expandable, each proven against its seeded mode.
- The drive or the map records the URL a blocked form would send to: `client-blocks-what-server-rejects` can expand to
  `network … absent: true` under ADR 0020 section g.
