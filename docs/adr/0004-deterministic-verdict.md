---
type: ADR
id: "0004"
title: "The verdict comes only from deterministic assertions"
status: accepted
date: 2026-09-29
---

## Context

An agent's "verified" verdict is usually just the model's word. The user said it clearly: a Haiku
subagent's verdict is not reliable evidence. The spike showed that System 1's `DONE` cannot be
trusted either: Laya reported `DONE` wrongly 9/9 times with high confidence, and Jev reported
`DONE` early on TodoMVC.

## Decision

**`passed`/`failed` is decided only by the verifier, using assertions written before the run
(network, text, url, value, noConsoleErrors), with a Playwright trace as evidence. System 1's
`DONE` is only a stop signal; during exploration, if assertions have not passed, `DONE` is
rejected and the model must choose again.** Assertions are written from the diff (dev) or the
acceptance criteria (tester), never from what the run observed.

## Options considered

- **Deterministic assertions + trace** (chosen): the verdict is repeatable and checkable.
- **The model judges by itself (screenshot + LLM judge, like proofrun)**: less to write, but it is
  what the user already rejected.
- **Combined: assertions + an LLM judge for the "visual" part**: adds cost and brings model
  judgment back into the verdict; reserved for deterministic visual diff if needed.

## Consequences

- **Easier:** accuracy is measurable. The seeded-bug suite catches 10/10, with 0 false reports on
  the clean app (phase 1).
- **Harder:** quality depends on assertion quality. Spike: the bug "API returns an empty list" slipped
  through because the flow had no data assertion. The skill requires flows that write data to have
  ≥1 state assertion.
- **Revisit when:** we need to verify things assertions cannot express (layout, images).

## Amendment 2026-10-29

Narrowed by the amendment in [ADR 0020](0020-assertion-provenance.md): a `baseline` assertion is an observed
value that a human approved with a signature, so its verdict is deterministic relative to that approval.
Everything else here is unchanged: a model never supplies an expected value, and only the verifier decides
pass or fail. ADR 0020 stays `proposed` until the owner accepts it.
