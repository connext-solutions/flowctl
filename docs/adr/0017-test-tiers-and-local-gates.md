---
type: ADR
id: "0017"
title: "Three test tiers, local gates via git hooks; CI deferred until there is a remote"
status: superseded
date: 2026-10-06
superseded_by: "0028"
---

## Context

The full test suite takes about 107 seconds and 8/11 files need a browser. An agent that changes one line waits almost
2 minutes for feedback. The repo has no remote, so there is no CI. The org is close to its GitHub Actions minutes quota.

## Decision

**Split tests into 3 vitest projects by file name: `unit` (`*.test.ts`, no browser, < 10 seconds),
`browser` (`*.browser.test.ts`), `accuracy` (`*.accuracy.test.ts`, the seeded bugs). `bun run check`
= Node check + lint + format + `tsc -b` + `unit`, target < 20 seconds; `bun run verify` = `check` +
all 3 tiers. Git hooks: `pre-commit` runs `check`, `pre-push` runs `verify`. Once there is a remote, CI runs
`verify`, with the `accuracy` tier running by label or nightly.**

## Options considered

- **3 tiers + git hooks** (chosen): fast feedback while editing, full coverage before push, no CI needed.
- **A single test suite**: simple, but each edit loop takes almost 2 minutes.
- **Rely on CI only**: there is no remote yet; and for the first team, pre-push is the real gate (CI does not run
  for PRs into develop).

## Consequences

- **Easier:** the agent runs `check` after every change without a long wait; broken commits are blocked locally.
- **Harder:** test files must use the right file-name suffix; pushes are about 2 minutes slower.
- **Revisit when:** the `unit` tier exceeds 20 seconds, or CI exists.
