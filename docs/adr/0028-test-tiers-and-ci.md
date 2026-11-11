---
type: ADR
id: "0028"
title: "Four test tiers; local gates and CI run the same verify; the contract tier stays manual"
status: accepted
date: 2026-11-04
---

Supersedes ADR 0017, which was written before the repository had a remote or CI.

## Context

ADR 0017 split the suite into three vitest projects, put `check` on `pre-commit` and `verify` on `pre-push`, and
deferred CI ("accuracy by label or nightly"). Since then the repository has a GitHub remote and two workflows,
the real System 1 got its own opt-in tier, and the suite grew: on the owner's laptop `check` takes 1 to 3
minutes and `verify` about 10 (481 unit, 135 browser and 27 accuracy tests on 2026-11-02); CI `Verify` takes
11 to 13 minutes. The organisation shares about 3,000 Actions minutes a month.

## Decision

**Four vitest projects chosen by file name: `unit` (`*.test.ts`, no browser), `browser` (`*.browser.test.ts`,
fixture-app), `accuracy` (`*.accuracy.test.ts`, seeded bugs) and `contract` (`*.contract.test.ts`, the real
TypeSafe Jev). `bun run check` = Node check, architecture gate, harness tests, lint, format, `tsc -b` and the tests type-check, the bundle
load check and `unit`; `bun run verify` = `check` + `browser` + `accuracy`. `pre-commit` runs `check`, `pre-push`
runs `verify`, and CI runs the same `verify` on every pull request (one job), next to a Security job (gitleaks,
blocking; `bun audit`, report only). The contract tier runs only by hand with a key loaded from `spike/.env`,
never in CI.**

## Options considered

- **Same `verify` locally and in CI** (chosen): a developer can reproduce any CI failure; nothing is stricter in
  CI than on a laptop (`.claude/rules/ci.md`).
- **Accuracy by label or nightly** (ADR 0017): saves minutes, but a verdict regression could merge unseen, and a
  nightly job spends minutes even on days with no change.
- **Contract tier in CI**: catches TypeSafe changes early, but it is billed, needs a secret in CI, and fails on
  remote latency rather than on code.

## Consequences

- **Easier:** one command defines "green" everywhere; a red CI run reproduces with `bun run verify`.
- **Harder:** pushes wait for `verify` (about 10 minutes locally); each PR costs about 13 Actions minutes.
- **Revisit when:** `verify` passes 15 minutes locally, monthly Actions use nears the budget, or a second
  runner platform is needed.
