---
type: ADR
id: "0001"
title: "System 1 drives the steps; System 2 only handles escalations"
status: accepted
date: 2026-09-29
---

## Context

When Claude Code or Codex verifies an FE flow through Playwright MCP, every click is a turn of
the large model. An ERP form flow of about 6 actions costs the orchestrator about 15–20 turns
(actions plus snapshot reads), while all the orchestrator needs is: does the flow work, and if
not, where does it fail. The users are devs and testers, and both work through agents.

## Decision

**A fast "System 1" model (picks the action + element in 1 request) drives each step. The
orchestrator (System 2) only hands over the goal, inputs and assertions, receives the verdict, and
steps in only when System 1 escalates** (`BLOCKED`, low confidence, a loop, hitting `maxSteps`, an
action outside the action space, `DONE` rejected by assertions 3 times).

## Options considered

- **System 1 drives, System 2 handles escalations** (chosen): the orchestrator spends 1 turn on the
  whole flow if nothing escalates. Hard steps are still decided by the large model.
- **Orchestrator drives through Playwright MCP itself** (current state): nothing to add, but it
  costs turns and tokens; the Playwright MCP README itself advises coding agents to use the CLI +
  a skill instead of MCP.
- **A cheap-model subagent (Haiku) drives**: cheaper than the large model, but the verdict is still
  model judgment; users do not accept it as evidence.
- **Hand everything to a hosted browser agent (Browser Use Cloud)**: cannot reach localhost, billed
  by the hour, and the verdict comes from a model.

## Consequences

- **Easier:** verifying a new flow costs 1 orchestrator turn (spike: 6-step ERP form, ~3.2 seconds).
- **Harder:** quality depends on System 1; clear escalation and loop detection are required.
- **Revisit when:** the share of steps that escalate on real flows exceeds 30% (the design target),
  or Playwright MCP/CLI solves the turn cost on its own.

## Advice

The user set the priority "System 1 for fast tasks so the orchestrator can synthesize faster"
(2026-09-29). The Milestone 0 spike confirmed it is feasible with Jev ([0002](0002-jev-default-system1.md)).
