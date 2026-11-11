---
type: ADR
id: "0016"
title: "Defer publishing; all packages stay private"
status: superseded
date: 2026-10-06
superseded_by: "0029"
---

## Context

A monorepo raises the publishing question: one bundled package, or many packages sharing one version. The repo
has a GitHub remote but no users outside the team.

## Decision

**Do not publish yet. Every package has `"private": true`. Team members install with
`bun link` in `packages/cli` or from git. The `cli` package keeps the name `@<company>/flowctl` so
publishing later needs no rename.**

## Options considered

- **Do not publish yet** (chosen): no publishing infrastructure before there are users.
- **Publish only `cli`, bundling internal packages**: users install one package, but a bundler is needed.
- **Publish every package with the same version**: no bundler needed, but every release pushes several
  packages.

## Consequences

- **Easier:** no version, changelog, or registry concerns for now.
- **Harder:** people outside the repo cannot install with `npx` yet; the Claude Code plugin (phase 2) must point to
  a local build.
- **Revisit when:** a team outside the company wants to use it, or the plugin needs to install via `npx`.

## Advice

The user chose the deferral option (2026-10-06).
