---
type: ADR
id: "0019"
title: "Exploration loop details: act on the chosen element, DONE waits for assertions, heal is opt-in"
status: accepted
date: 2026-10-06
---

## Context

The phase 2 spec and ADRs 0001–0006 set the direction: System 1 drives, assertions decide, escalate when
needed. While writing code, some points were still unclear in the spec, and some parts of jev-ultrafast did not fit
flowctl (LLM text generation, picking individual select options).

## Decision

1. **Actions run on exactly the element System 1 (or the orchestrator) chose**, temporarily marked with the
   `data-flowctl-target` attribute. The recorded step uses a locator computed by Playwright (testId, then role
   + accessible name). A recorded locator that is not unique surfaces in the confirming replay of
   `saveExploration`; it is not hidden.
2. **SELECT targets the select element itself**; the value is a key of `inputs` (the `value` question),
   not an individual option as in jev.
3. **DONE:** wait for assertions up to `assertTimeout` before rejecting. On rejection, run the executable action
   with the second-highest probability, with no confidence threshold. After 3 consecutive rejections, escalate with `done_rejected`,
   including the failing assertions.
4. **Early stop:** before each decision, check assertions once without waiting. If all pass (and there is at least
   one state assertion), finish with `passed`.
5. **Add the escalation reason `action_failed`** (the action errored: element covered, not found…).
6. **Step recording:** WAIT is not recorded; scrolling is recorded as `scroll: ±560`; PRESS_ENTER is recorded as `press: Enter`; steps
   done by the orchestrator are recorded with `by: system2`; the run's `{{uid}}` values are turned back into templates.
7. **Secret values** (`{ env }`) are replaced with `***` in everything sent to System 1.
8. **Heal is opt-in** (`replayFlow(..., { system1 })`, CLI `--heal`), only within `allowedEnvs`. It only
   overwrites the locator of the healed step, keeps comments unchanged, and only when the whole run passes.

## Options considered

- **Act through the recorded locator** (instead of point 1): checks uniqueness right away, but ERP tables with
  many identical "Sửa" buttons would get exploration stuck; we chose to surface the error at the save step.
- **Reject DONE immediately without waiting**: faster, but APIs of lazy-loaded routes arriving late (spike) cause
  false rejections.
- **Pick select options as jev does**: natural for the model, but the value does not come from `inputs`, against ADR 0006.

## Consequences

- **Easier:** every recorded step has actually run; the confirming replay blocks flows that cannot replay.
- **Harder:** each wrong DONE costs up to `assertTimeout`; date-dependent names (`{{today}}`) are not
  turned back into templates.
- **Revisit when:** the `done_rejected` rate on real flows is high, or heal is needed for upload/drag.
