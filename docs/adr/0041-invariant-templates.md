---
type: ADR
id: "0041"
title: "Invariants are templates with a fixed expansion: they bind to evidence, judge what was observed and expand only where the assertion schema can say it"
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
(`no-5xx`, `no-console-error`) already exist in `observe/checks` and must not get a second implementation.

## Decision

1. **A template has four parts.** `core/src/derive/invariants/` (layer `derive`, not exported from the package) holds
   `INVARIANTS`, one `InvariantTemplate` per id in `INVARIANT_IDS`: `crud-create-appears`, `crud-edit-shows`,
   `crud-delete-absent`, `reload-keeps-data`, `no-5xx`, `no-console-error`, `round-trip-equality`,
   `state-change-after-action`, `success-toast-implies-2xx`, `client-blocks-what-server-rejects`.
   - `params`: a strict zod schema. Fields are paths, controls (role and name), an optional `within` locator or
     `valueFrom: <input name>`, where the name is a flow name (`NAME_PATTERN`). No free text, no status class, no
     `absent` flag, no ref (ADR 0020 section c). An unknown key is a refusal.
   - `bind(evidence, params)`: ties the parameters to evidence and returns a `Refusal` (`no_evidence`, `bad_input`,
     `bad_params`, each with a fixed sentence, never page text) when the page is not in the map, the drive has no step
     of that kind, or the value input is not a `{ value }` input holding a `QA-` value made unique by `{{uid}}`.
   - `evaluate(evidence, params)`: the observation-time verdict. Findings carry a `sourceRef`
     `{ kind: 'invariant', ref: <id> }` and an `observation` JSON Pointer into `appmap.json` or `drive.json`. A refusal
     is not a pass.
   - `expand(evidence, params)`: the whole assertion, with its `sourceRef` added by the library (`kind` and `ref`
     only, no quote, no revision), or `not_expandable` with a sentence.
2. **`invariantResolves(assertion, params, evidence)` is whole equality.** It reads the template from
   `assertion.sourceRef.ref`, expands it for the same parameters and evidence and demands the canonical forms are
   equal, so an edited status, an extra `within`, a quote in the `sourceRef`, a ref that names no template, parameters
   the template does not define or evidence that no longer holds the step all fail closed. This is the unit T4.5 signs
   and T4.3 and `check` call. Two templates may write the same assertion for the same parameters (`crud-create-appears`
   and `reload-keeps-data`): the ref is what the case claims, and each must bind on its own evidence.
3. **Evidence is the map plus a drive record.** `InvariantEvidence` is `{ map, drive?, inputs }`. `DriveRecord` is a
   strict schema of steps (action, page, control, field, the value sent, the request and its status or `null`, whether
   the client blocked, the page state before, after and after a reload, the value read back, the status text). Every
   text is bounded and free of control and invisible code points, every value written starts with `QA-`, and no
   expected value is read from a run. T2.8 must emit this shape, or the schema moves to `observe/` and is imported;
   until then the tests build it with a drive written for them.
4. **The free checks are wrapped.** `no-5xx` and `no-console-error` call `freeChecks(map)` and pick the check of the
   same id, so a verdict cannot differ from `flowctl observe`. A case made only of free invariants is smoke-only
   (`isSmokeOnly`).
5. **Evaluate is always available; expand only where the schema can say it.** Not expandable today: `no-5xx` (a status
   class), `crud-delete-absent` (text absence), `state-change-after-action` (a comparison of two observations) and
   `client-blocks-what-server-rejects` (a status class that is what the probe observed, never chosen). Such a case
   stays an observation or smoke-only until a flow-schema task adds the kind with its own seeded bug. This decision
   does not widen the assertion schema. The expandable ones: `text` for the three CRUD rows that show a value (the
   template text of the input, for example `QA-{{uid}}`, copied because ADR 0026 has no input reference inside an
   assertion), `value` for round-trip equality, `network` with the exact status the accepted request had for the
   toast invariant (refused when the path holds a glob character) and `noConsoleErrors`.
6. **Each invariant has a seeded bug, and each bug is caught by exactly one invariant.** fixture-app gets
   `INVARIANT_BUG_MODES` on the `/items` app, kept out of `BUG_MODES` because no flow assertion catches them:
   `createNotListed`, `editNotShown`, `deleteStillListed`, `reloadLosesData`, `readBackAltered`, `itemApproveNoop`,
   `toastOnConflict`, `clientLimitMissing`. The free invariants reuse the crawl modes `page500`, `call500` and
   `pageConsoleError`. `invariants.accuracy.test.ts` pins one invariant per mode, written from the defect, and the
   clean app finds nothing. T4.7 counts from that table, so it stays stable.

## Options considered

- **Wait for T2.8.** Rejected: the templates need a settled evidence shape to be tested at all, and a stub of the drive
  runtime would be thrown away. Defining the record here and requiring T2.8 to match it costs one schema.
- **Widen the assertion schema now (`textAbsent`, `statusClass`).** Rejected: a new assertion kind needs its own seeded
  bug, verifier change and ADR (extend-engine). Marking four templates `not_expandable` keeps this task inside its
  paths and loses no verdict, since `evaluate` still judges them.
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

- Four of ten templates produce no flow assertion yet, so a derived case holds them only as observations.
- The drive record is a contract with T2.8; a change to it after T4.3 starts is rework.
- `/items` is shared with the run ledger tests: its page changed (rows now hold a state, a rename field and two
  buttons, and a name over 40 characters is blocked), and a mode must default off and never survive `reset()`.

### Revisit when

- T2.8 lands: replace the test drive with the real stage and move `DriveRecord` if it differs.
- A flow-schema task adds a status class or text absence: make the four templates expandable, with a seeded bug each.
