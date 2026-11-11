---
type: ADR
id: "0013"
title: "Configurable flows location; each flow lives in exactly one place"
status: accepted
date: 2026-10-03
---

## Context

For the first team, flows can live in `qa-tests` (owned by QA, already has post-deploy CI and teardown
rules for staging) or in `web-frontend` (shipped with the feature PR). The vision is to serve any
web app, not only the ERP.

## Decision

**`flowsDir` in `flowctl.config.yaml` decides where flows live, including pointing to another repo
(for example `../qa-tests/flows`). Each flow lives in one place only; flowctl does not sync across
locations. The config is found via `--config` or by walking up parent directories.**

## Options considered

- **Configurable, one place** (chosen): stays flexible without syncing.
- **Fixed in the QA repo**: QA owns it, but the feature and the flow land in two different PRs.
- **Fixed in the app repo**: reviewed in the same PR, but QA's CI must pull from another repo.
- **Draft in the app repo, then move to the QA repo**: rejected by the user because two locations drift easily.

## Consequences

- **Easier:** each team picks the place that suits it; integrating `qa-tests` is just config.
- **Harder:** when `flowsDir` points to another repo, flow commits happen in that repo.
- **Revisit when:** flows need to be shared across several repos.

## Advice

The user chose "A or B, not C, keep it flexible" (2026-09-29).

## Amendment 2026-11-01: `flowsDir` is contained

Accepted by the owner on 2026-11-02, as written and including the recommended default of each decision it marks; task T0.21 is closed. The decision above stands:
`flowsDir` may point to another repository. It is now subject to the containment rules of [ADR
0024](0024-target-scope-and-guards.md) section 1a: a project-relative path strictly inside the project root, or
a flows root the owner registered in the per-machine trust store ([ADR 0025](0025-trust-store.md)) referenced by
name, or the `../other-repo/flows` form only when it resolves into such a registered root. An unregistered
`..` path, a symlink in the chain and a path that contains the store are refused. The cross-repo layout therefore
needs one `flowctl trust add root` on each machine. Status stays `accepted`; ADRs 0024 and 0025 are still
`proposed`.
