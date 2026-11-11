---
type: ADR
id: "0015"
title: "Monorepo with workspaces (Bun); each package is a deep module"
status: accepted
date: 2026-10-06
---

## Context

After phase 1, flowctl has 11 flat modules in `src/`. Phase 2 adds an MCP server, an exploration loop
with the Jev client, and a Claude Code plugin. The user wants the monorepo set up now so it is easy to extend.
The run lifecycle currently lives in `replayFlow`, and `explore` in phase 2 needs exactly that lifecycle.

## Decision

**Use workspaces (`packages/*`, managed by Bun per [0018](0018-bun-package-manager-node-runtime.md)), build with TypeScript project references (`tsc -b`), test
with vitest projects. Three initial packages: `core` (`@<company>/flowctl-core`), `cli`
(`@<company>/flowctl`, bin `flowctl`), `fixture-app` (tests only). Packages import each other
only by package name, that is, through `index.ts`. The run lifecycle is extracted into a `RunSession` seam
in `core`.**

## Options considered

- **Workspaces + project references** (chosen): the `workspaces` field is built into Bun/npm, project references are built into tsc; no extra build tool.
- **Nx / Turborepo**: good task caching and dependency graph, but overkill for 3–5 packages and one more
  tool to learn.
- **pnpm workspaces**: fast and strict, but Bun is fast enough and already used in the workspace (internal-wiki).
- **Keep one package, split folders by module**: fewest changes, but no real boundary
  between modules, and a refactor is needed when adding MCP/plugin.

## Consequences

- **Easier:** adding `mcp`, `explore`, or a plugin is just adding a package; each module's interface is
  enforced by `index.ts`; `fixture-app` is shared by the tests of every package.
- **Harder:** `core` must be built before `cli` typechecks (`tsc -b` handles this); each package has its own
  `package.json` and `tsconfig.json`.
- **Revisit when:** there are more than about 8 packages, or build/test time starts to need caching.

## Advice

The user asked to "set it up as a monorepo first so it is easy to extend later" (2026-10-06).
