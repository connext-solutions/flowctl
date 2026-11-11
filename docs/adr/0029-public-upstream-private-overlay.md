---
type: ADR
id: "0029"
title: "flowctl is an Apache-2.0 public repo; company-specific tools live in a private overlay"
status: proposed
date: 2026-11-09
---

## Context

flowctl was first built in one private repo that held both the engine and company-only parts: a spec plugin for
an internal wiki, skills that drive the company's test-case sheets and trials on its app, and internal planning
notes. ADR 0016 kept every package private and unpublished.

The owner decided on 2026-11-09 to open-source the engine, and wants the company tools to pick up every public
change without porting it by hand. The engine was already written as if it were public: the architecture gate
forbids core, cli and mcp from naming a plugin (`scripts/check-arch.mjs`, `scripts/check-bundle-plugins.mjs`).

The unscoped npm name `flowctl` is taken by an unrelated package; the `@flowctl` scope had no packages on
2026-11-09.

## Decision

1. **This repository, `github.com/connext-solutions/flowctl` (Apache-2.0), is the upstream of the engine:** `packages/core`,
   `packages/cli`, `packages/mcp`, `packages/fixture-app`, the generic skills and the ADRs. Company-specific
   plugins, skills and notes live in a separate private repository (the *overlay*).
2. **The overlay consumes released packages.** It depends on the public packages by release (GitHub Release
   tarballs, ADR 0031), and never copies engine source. An engine change is made here, reviewed here,
   released, and picked up by the overlay with a version bump.
3. **Package names:** `@flowctl/core`, `@flowctl/cli` (bin `flowctl`), `@flowctl/mcp`; fixture-app stays
   unpublished (`private: true`). Amended 2026-11-11 by ADR 0031: they are released as GitHub Release tarballs,
   not on npm.
4. **The first public commit was a one-time export** of the private repo's engine files with no history, after a
   scrub of internal names and a scan (gitleaks plus an internal-name list). There is no second sync in that
   direction.
5. **Licence:** Apache-2.0, with a `LICENSE` and a `NOTICE` file.

This supersedes ADR 0016 ("defer publishing").

## Options considered

- **Export copy, private repo stays the source of truth:** no split, but public changes must be ported back by
  hand and every sync is a leak risk.
- **Public upstream, private overlay** (chosen): one source of truth per file; internal code never enters the
  public repo; internal tools get public fixes with a version bump. Costs one split and a stable plugin interface.
- **One public repo with a private branch or fork:** the company code would sit one merge away from the public
  history; rejected.
- **Git submodule of the public repo inside the private one:** ties the overlay to a commit rather than a release
  and makes CI and installs heavier; kept as a fallback only.

## Consequences

- **Easier:** outside contributions land once; internal tools update with `bun update`; the plugin boundary is a
  real package boundary.
- **Harder:** a change that needs both an engine change and a company change takes two pull requests and a
  release in between; the plugin interface (`SpecProvider`, the MCP tools, the CLI) must stay stable or be
  versioned; releases need a changelog and semver.
- **Not finished at the first export:** an overall time limit for a run and a destructive-request guard for
  replay (exploration is guarded). The README marks the release as an early preview until they land.
- **Revisit when:** the overlay needs engine changes faster than releases
  allow, or a second overlay appears.
