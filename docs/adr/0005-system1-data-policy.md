---
type: ADR
id: "0005"
title: "Jev runs only on local/staging; production is replay only"
status: accepted
date: 2026-10-03
---

## Context

Each Jev decision sends TypeSafe the URL, the page title, up to 6,000 characters of visible text,
and the control labels. In the ERP, that can be employee names, attendance data, or salaries.

## Decision

**System 1 may be used only in the envs listed in `system1.allowedEnvs` (default
`[local, staging]`, with seed or test data). In any other env `flow_run` returns
`error: system1_not_allowed`; only `flow_replay` is allowed, and replay sends no data anywhere.**

## Options considered

- **Local/staging only** (chosen): real data does not leave our infrastructure; still enough for
  devs and testers.
- **All envs**: convenient, but needs a data processing agreement with TypeSafe first.
- **Send nothing outside**: forces self-hosted Laya, which the spike showed is not usable yet, so
  v1 would have no System 1.

## Consequences

- **Easier:** a clear rule, controlled by config, with a dedicated error so the agent cannot quietly
  bypass it.
- **Harder:** staging must use seed/test data, not a copy of production.
- **Revisit when:** there is a data agreement with TypeSafe, or a good enough self-hosted System 1.

## Advice

The user chose option A (2026-10-03).

## Amendment 2026-10-29

The allowed-envs list is now one list shared with `target` settings and anchored in the per-machine trust
store (ADR 0025); the repository can only remove entries. Replay without heal on a production origin is
limited to read-only requests and needs a store entry ([ADR 0024](0024-target-scope-and-guards.md)
section 2a). Both ADRs are `proposed` until the owner accepts them.

## Amendment 2026-11-01: who may run read-only on production, and what evidence it keeps

Accepted by the owner on 2026-11-02, as written and including the recommended default of each decision it marks; task T0.23 is closed.

Read-only replay on a production origin (above) is further limited by [ADR 0024](0024-target-scope-and-guards.md)
section 2a. Only a profile the owner registered for that purpose may run it, ideally a viewer account in the
target application. The session is created by the owner interactively, never by `login --auto`. Request
matching is an allowlist of method, path template, query rule and header names, with no denylist of
method-override names. **Data policy for the evidence:** a production run keeps no trace, screenshot, video,
DOM snapshot or response body, and records an assertion's actual text only as its length and result. "Replay
sends no data anywhere" is about the System 1 endpoint; production data must not land on disk or in CI
artifacts either. **Stated limit (verdict oracle):** a pass or fail is one bit about page content, so a flow
author can probe production values with assertions; read-only replay keeps data off disk and out of artifacts
and does not make it unreadable to whoever can edit a flow, which is why only reviewed flows may run there
(ADR 0024 section 2a). Status stays `accepted`; ADRs 0024 and 0025 are still `proposed`.
