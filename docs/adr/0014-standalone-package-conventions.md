---
type: ADR
id: "0014"
title: "Standalone package in the company workspace with its own conventions"
status: accepted
date: 2026-10-06
---

## Context

flowctl targets any web app but is developed next to the company repos. Workspace conventions
(path aliases, the frontend's oxfmt `semi: false`) were written for apps with a bundler.

## Decision

**flowctl is a separate git repo at `<company>/flowctl`, published as
`@<company>/flowctl` (binary `flowctl`). Node 22.22.2 per `.nvmrc`, strict TypeScript
with `noUncheckedIndexedAccess`, ESM NodeNext. Imports inside the package use relative paths with a
`.js` extension (a deliberate exception to the workspace alias rule). oxfmt follows the
api-backend config (`semi: true`, single quotes, width 80) since both are Node code.**

## Options considered

- **Separate repo, Node conventions** (chosen): can be published independently; no bundler needed to resolve aliases.
- **Path aliases like the apps**: consistent with the workspace, but `tsc` does not rewrite aliases, so
  we would add a bundler or a package `imports` map just to keep the convention.
- **Place it in an existing repo (qa-tests)**: close to where it is used, but ties a general tool to the ERP.

## Consequences

- **Easier:** builds with `tsc`, runs with `npx`; no dependency on the ERP repos.
- **Harder:** import conventions differ from the sibling repos; readers need to know this exception.
- **Revisit when:** flowctl becomes a multi-package monorepo.

The user settled on the name `flowctl`; the npm package `flowctl` already belongs to Spacelift, so it is published under
the `@<company>` scope.
