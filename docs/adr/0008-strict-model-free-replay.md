---
type: ADR
id: "0008"
title: "Replay uses no model and is strict by default; heal never touches assertions"
status: accepted
date: 2026-09-29
---

## Context

A verified flow must rerun fast and reliably: a dev fixes a bug and reruns, a tester runs
regression after a deploy. When the UI changes, locators can break. Healing saves manual fixes,
but it can hide a real regression (for example, heal clicking a different "Lưu" button by
mistake).

## Decision

**Replay does not call a model. When a locator matches 0 or >1 elements: CLI/CI fails (strict by
default, `--heal` to enable); MCP heals that one step with System 1. Heal never changes
assertions; the yaml is overwritten only when heal succeeds and every assertion passes, and the
result records `healed: [...]`. `flow_save` replays once to confirm before writing the file.**

## Options considered

- **Strict by default, heal opt-in, assertions immutable** (chosen): CI does not hide regressions;
  the agent can still self-heal while working.
- **Heal by default everywhere**: fewer manual fixes, but CI can go green while the UI changed
  unintentionally.
- **No heal**: simplest, but every label change means a manual fix.

## Consequences

- **Easier:** replay is fast and stable. Spike: 50/50, median 0.44–1.25 seconds; phase 1 ran a full
  two-role flow on the sample app.
- **Harder:** flows must be recorded with robust enough locators ([0009](0009-locator-strategy.md)).
- **Revisit when:** the heal count is unusually high; use it as a signal to add `data-testid`.

Phase 1 implemented strict replay, `repeat` and flaky detection. Heal and `flow_save` belong to phase 2.

## Amendment 2026-10-29

A healed locator is not written back silently: `save` refuses a flow containing a healed step unless the
caller confirms it ([ADR 0022](0022-driver-seam.md), task T5.8). Replay itself stays model-free and strict.
ADR 0022 is `proposed` until the owner accepts it.
