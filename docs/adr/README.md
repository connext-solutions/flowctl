# Architecture Decision Records

flowctl's design decisions.
Measurements they rely on: Milestone 0 spike report (not published).

## Format

Each ADR is a markdown file with frontmatter written in English:

```
---
type: ADR
id: "0001"
title: "Short decision name"
status: proposed        # proposed | accepted | active | superseded | retired
date: YYYY-MM-DD
superseded_by: "0007"  # only when status: superseded
---

## Context
## Decision
## Options considered
## Consequences
## Advice   (optional)
```

- `proposed`: decided, no code yet (belongs to phase 2: exploration with Jev, MCP, Skill).
- `accepted`: decided and implemented.
- `active`: in real use in the team's workflow.
- An ADR may be `accepted` while a later amendment to it is `proposed`: the status describes the body, and each
  amendment says in its first lines whether the owner has accepted it. An index note such as "(amended: ...)"
  names a proposed amendment, not an implemented one.

## Rules

- One decision per file, named `NNNN-short-name.md`, numbered in increasing order.
- An `active` ADR is no longer edited; replace it with a new ADR and mark it `superseded`.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-system1-drives-system2-escalates.md) | System 1 drives the steps; System 2 only handles escalations | accepted |
| [0002](0002-jev-default-system1.md) | TypeSafe Jev is the default System 1; Laya is not in v1 | accepted |
| [0003](0003-single-systemone-client.md) | One HTTP client for the `/v1/systemone` protocol, no interface | accepted |
| [0004](0004-deterministic-verdict.md) | The verdict comes only from deterministic assertions (narrowed by the ADR 0020 amendment: baselines) | accepted |
| [0005](0005-system1-data-policy.md) | Jev runs only on local/staging; production is replay only (amended by ADRs 0024, 0025: one trust-anchored list; amended: read-only production replay is allowlisted and keeps no response bodies or screenshots, ADR 0024 section 2a) | accepted |
| [0006](0006-no-text-generation.md) | No LLM text generation; input values come from the orchestrator | accepted |
| [0007](0007-yaml-source-of-truth.md) | YAML is the single source of truth; spec export deferred | accepted |
| [0008](0008-strict-model-free-replay.md) | Replay uses no model and is strict by default; heal never touches assertions (amended: healed steps are not saved silently) | accepted |
| [0009](0009-locator-strategy.md) | Locators: testId, then role + accessible name computed by Playwright, must match exactly 1 | accepted |
| [0010](0010-assertion-semantics.md) | Assertion semantics: wait with a timeout, fetch/xhr only, evidence from before navigation (amended: url and network match only the run's origins, `text.within`, no pass before the first action) | accepted |
| [0011](0011-login-via-profiles.md) | Log in only through profiles/storageState (amended: sessions move to the trust store's sessionDir) | accepted |
| [0012](0012-mcp-for-explore-cli-for-replay.md) | MCP for exploration, CLI for replay/CI; `flow_run` waits ~60 seconds | proposed |
| [0013](0013-flexible-flows-location.md) | Configurable flows location; each flow lives in exactly one place (amended: `flowsDir` contained by ADR 0024 section 1a) | accepted |
| [0014](0014-standalone-package-conventions.md) | Standalone package in the company workspace with its own conventions | accepted |
| [0015](0015-workspaces-monorepo.md) | Monorepo with workspaces (Bun); each package is a deep module | accepted |
| [0016](0016-defer-publishing.md) | Defer publishing; all packages stay private | superseded by 0029 |
| [0017](0017-test-tiers-and-local-gates.md) | Three test tiers, local gates via git hooks; CI deferred until there is a remote | superseded by 0028 |
| [0018](0018-bun-package-manager-node-runtime.md) | Bun as package manager and script runner; Node 22 as runtime | accepted |
| [0019](0019-exploration-loop.md) | Exploration loop details: act on the chosen element, DONE waits for assertions, heal is opt-in | accepted |
| [0020](0020-assertion-provenance.md) | Every generated assertion carries a typed sourceRef: spec, contract, invariant or baseline (amended: provenance state on every replay, section h) | proposed |
| [0021](0021-hook-consent.md) | Shell hooks run only with consent recorded on this machine (amended: consent in the trust store; no blanket flag; digest covers the files the hook calls; hooks run with an allowlisted environment) | accepted |
| [0022](0022-driver-seam.md) | System 1 becomes a Driver interface; Jev and a generic LLM client are adapters | proposed |
| [0023](0023-spec-provider-seam.md) | SpecProvider seam and the private-plugin boundary | proposed |
| [0024](0024-target-scope-and-guards.md) | Target scope, credentials and run guards, anchored in the trust store | proposed |
| [0025](0025-trust-store.md) | Trust anchors live in an owner-controlled per-machine trust store; repo files can only tighten | proposed |
| [0026](0026-template-syntax.md) | Template syntax is a closed grammar; errors are strict and found at load | accepted |
| [0027](0027-mcp-server-package.md) | The MCP server is its own package on the v2 MCP SDK; every tool is guarded | accepted |
| [0028](0028-test-tiers-and-ci.md) | Four test tiers; local gates and CI run the same verify; the contract tier stays manual | accepted |
| [0029](0029-public-upstream-private-overlay.md) | flowctl is an Apache-2.0 public repo; company-specific tools live in a private overlay | proposed |
| [0030](0030-evidence-safe-to-share.md) | Evidence is safe to share by default; a full trace is an explicit opt-in | proposed |
| [0031](0031-github-release-tarballs.md) | Releases are GitHub Releases with npm tarballs; no npm registry | accepted |
| [0032](0032-demo-video.md) | Demo videos: an opt-in replay recording with a step overlay that assertions cannot see | accepted |
