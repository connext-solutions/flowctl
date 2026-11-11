---
type: ADR
id: "0018"
title: "Bun as package manager and script runner; Node 22 as runtime"
status: accepted
date: 2026-10-06
---

## Context

The user wanted to consider moving to Bun for both package manager and runtime (internal-wiki in the
workspace already runs on Bun). flowctl's core drives a browser with Playwright, and Playwright
officially supports only the Node runtime. A spike measured on the phase 1 code (Bun 1.2.16, Node 22.22.2, M1 Pro):

| Measurement | Result |
|---|---|
| Install, warm cache | npm 15.1 seconds · Bun 1.6 seconds |
| `bun run test` (vitest on Node) | 72/72 pass |
| `bun --bun vitest run` (vitest on Bun) | 70/72; rerunning only the seeded-bug suite: 10/11, then 7/11 (294 seconds) |

The failures under the Bun runtime sit in the connection layer between Playwright and the browser (`Target page, context or
browser has been closed`, `Failed to connect ENOENT`, tests hanging until timeout), and each run failed in a
different place. Under Node, the same suite passed on every run in the session.

## Decision

**Use Bun as package manager and script runner (`bun install`, `bun run …`, `bun.lock`,
`"packageManager": "bun@1.2.16"`). The runtime for tests, CLI and MCP stays Node 22 (bins use
`#!/usr/bin/env node`; vitest runs on Node, as it does when invoked through `bun run`). Do not use `bun --bun`
and do not use `bun test`.**

## Options considered

- **Bun for install + scripts, Node runtime** (chosen): installs about 10x faster, no loss of reliability.
- **Bun as runtime too**: runs TS directly, no build needed; but tests fail randomly exactly in the
  core part (the browser), against the product's "reliability" goal.
- **Stay fully on npm**: nothing changes, but installs are about 10x slower.

## Consequences

- **Easier:** fast installs and dependency changes; workspaces use the same `workspaces` field as npm.
- **Harder:** dev machines need both Bun and Node 22. `.npmrc engine-strict` has no effect under
  Bun, so blocking the wrong Node version relies on `engines` and the `check:node` script.
- **Revisit when:** Playwright officially supports the Bun runtime, or the `accuracy` suite passes reliably
  many times in a row under a newer Bun.

## Advice

The user proposed considering Bun, agreed to run the spike, and settled on the split option (2026-10-06).
