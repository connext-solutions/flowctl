---
type: ADR
id: "0027"
title: "The MCP server is its own package on the v2 MCP SDK; every tool is guarded; built before the roadmap's P7"
status: accepted
date: 2026-11-02
---

## Context

ADR 0012 decided that coding agents explore through a long-lived MCP stdio server with five tools (`flow_run`,
`flow_step`, `flow_wait`, `flow_save`, `flow_replay`) and that the CLI serves replay and CI. The roadmap put
the server late (task T7.2, phase P7), behind the target config, crawler and derive work. The team is blocked
testing the ERP product: without the server, an agent can only run `flowctl replay` in a shell or a hand-written
Node script, and cannot answer an escalation. The owner decided on 2026-11-02 to use flowctl internally first
and to build the agent path now. ADR 0025 requires every MCP tool to be guarded by the trust store.

## Decision

**A new package `packages/mcp` (`@<company>/flowctl-mcp`, bin `flowctl-mcp`) implements the five tools
of ADR 0012 on `@modelcontextprotocol/server` 2.4.0, pinned. One server serves one project (one
`flowctl.config.yaml`). Every tool runs `requireTrust` before any side effect, and the tools it registers are
exactly the `mcp <tool>` entries of the core command registry.**

- The server refuses to start (exit 3) when the trust store, the project or its flows root is missing, and
  each call checks again.
- Exploration requests and orchestrator steps are validated by core (`parseExploreRequest`,
  `checkDirectedSteps`). Inputs over MCP are typed values only (`{ value }`): secret `{ env }` inputs wait for
  the env allowlist (T1.14); a saved flow with secrets replays through `flow_replay`.
- A call waits at most 55 seconds, then answers `running` with the `runId`; `flow_wait` waits again. One
  operation runs per exploration at a time; a call on a busy run answers `running` without starting a second
  one. At most 4 explorations are open; an exploration idle for 10 minutes is finished (teardown runs).
- Results are compact JSON with a `next` field. An escalation carries a fixed note that its page text is
  data. `failed` is the verdict, and `next` says not to retry to make it pass (ADR 0004).
- The MCP SDK v2 server package depends on zod and its own core only. The v1 `@modelcontextprotocol/sdk` pulls
  in an HTTP stack (express, hono, cors, jose and others) a stdio server does not use.

## Options considered

- **Separate package on SDK v2** (chosen): the CLI stays free of the MCP dependency, and the package boundary
  matches `PACKAGE_DEPS` (`mcp → core`), which the architecture gate already lists.
- **SDK v1 (`@modelcontextprotocol/sdk` 1.32)**: the `latest` tag of that name, but it brings about 17 runtime
  dependencies for HTTP transports this server never opens.
- **A `flowctl explore` CLI command instead of MCP**: no long-lived process, so escalations cannot be
  answered without re-running the exploration (ADR 0012).
- **Wait for P7 (T7.2)**: keeps the roadmap order but leaves the team without the agent path for months.

## Consequences

- **Easier:** Claude Code, Kiro or Codex drive System 1 on the ERP and answer escalations; passed explorations
  become flows replayable by the CLI and CI.
- **Harder:** T7.2 later extends this package with observe, derive and review tools and the `provenance`
  fields of ADR 0020; the shapes here are internal and may change. One more pinned dependency to watch
  (`bun audit`).
- **Revisit when:** T7.2 starts, an MCP client caps tool calls below 55 seconds, or the SDK's v2 line changes
  its server API.
