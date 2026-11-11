---
type: ADR
id: "0007"
title: "YAML is the single source of truth; spec export deferred"
status: accepted
date: 2026-10-03
---

## Context

At first the user chose the direction "record → replay → export a Playwright spec" (2026-09-29).
When the scope was reviewed against the goal "verify FE for devs and testers", a TS spec served no
one: devs do not need a spec file, and the company's testers use Python POM (`qa-tests`).

## Decision

**`.flows/<name>.yaml` is the single source of truth for a flow. Replay runs the yaml directly.
Export to `.spec.ts` / pytest-POM is deferred out of v1; if done later, the spec is always
regenerated from the yaml.**

## Options considered

- **YAML as source, export deferred** (chosen): one format, replayable and self-healing, no model.
- **YAML as source, export regenerated each time**: adds a by-product that has no users yet.
- **Export once, then diverge**: testers edit the spec freely, but lose healing and yaml replay.

## Consequences

- **Easier:** less code; flows are reviewed like code in PRs; testers run regression with
  `flowctl replay`.
- **Harder:** teams used to writing TS specs must accept the yaml format.
- **Revisit when:** QA wants to move flows to pytest-POM (an exporter using `BasePage` from
  qa-tests), or another team needs TS specs.

## Advice

The user agreed to defer export "as long as the flow and scope cover both devs and testers using
agents" (2026-10-03).
