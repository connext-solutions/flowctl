---
paths:
  - ".github/**"
  - ".githooks/**"
  - "scripts/**"
  - ".nvmrc"
  - "package.json"
---

# CI and infrastructure rules

- **Actions budget:** the org shares about 3,000 minutes a month and GitHub bills every job rounded up to the
  minute. One job per workflow; no aggregator jobs; no `push` trigger for what a PR already checked;
  `concurrency` with `cancel-in-progress`; `timeout-minutes` on every job.
- **Required checks never skip:** a workflow behind branch protection has no `paths-ignore` (a skipped required
  check blocks the merge).
- **Least privilege:** `permissions: contents: read` unless a step needs more; secrets only in the step that uses them.
- **Pinned tools:** actions by full commit SHA with the version as a comment (`actions/checkout@<sha> # v6.1.0`),
  images by tag plus digest (`gitleaks:v8.30.1@sha256:…`), Bun from `packageManager`, Node from `.nvmrc`. Caches
  are keyed on `bun.lock`. `actions/checkout` always sets `persist-credentials: false`. Resolve a SHA with
  `gh api repos/<owner>/<repo>/commits/<tag> --jq .sha`.
- **The local gates are the same as CI:** `pre-commit` → `check`, `pre-push` → `verify`, CI → `verify`. Never make
  CI stricter than what a developer can run locally, and never skip a hook to get a push through.
- **Upgrading Playwright or Node:** bump in one PR; `bun install` updates `bun.lock` (which also refreshes the
  browser cache key); update `.nvmrc`, `engines` and `scripts/check-node.mjs` together; run `verify` and the
  contract tier; record the change in an ADR if the minimum version moves.
- The contract tier (real Jev) never runs automatically in CI: it is billed and needs a key.
