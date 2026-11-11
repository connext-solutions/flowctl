---
type: ADR
id: "0012"
title: "MCP for exploration, CLI for replay/CI; flow_run waits ~60 seconds"
status: proposed
date: 2026-09-29
---

## Context

Exploration with escalation must keep the browser and run state across many orchestrator calls. Replay
needs no state and must run in CI. Playwright recommends that coding agents use CLI +
skill to save tokens, but a CLI runs once and exits.

## Decision

**A long-lived MCP stdio server holds one browser and many runs (`runId`), with 5 tools: `flow_run`,
`flow_step`, `flow_wait`, `flow_save`, `flow_replay`. The CLI (`flowctl replay`, `flowctl login`)
shares the same core, has no escalation, and serves testers and CI. `flow_run`/`flow_step` wait at most
about 60 seconds; past that they return `running` + `runId` so the caller can call `flow_wait`. Ship a Skill with 2 playbooks
(dev, tester) and a `flow-verifier` subagent that returns the result JSON verbatim.**

## Options considered

- **MCP for exploration + CLI for replay** (chosen): each side does the job it fits.
- **CLI only (daemon/session style)**: matches Playwright's recommendation, but we must manage the daemon ourselves.
- **`flow_run` returns `runId` immediately, then poll**: flexible, but costs extra turns, which is exactly what the tool
  aims to save.

## Consequences

- **Easier:** most flows finish in 1 turn; the tool schema is small.
- **Harder:** run lifecycle must be managed (clean up abandoned runs after 10 minutes, run teardown).
- **Revisit when:** an MCP client caps tool-call time below 60 seconds.

## Advice

The user chose the wait-with-timeout option (2026-09-29). The CLI exists since phase 1; MCP belongs to phase 2.
