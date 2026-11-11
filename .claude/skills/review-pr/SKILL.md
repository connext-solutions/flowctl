---
name: review-pr
description: Use when asked to review a flowctl pull request (by number or branch). Checks CI, runs verify locally, delegates the checklist to the flowctl-reviewer subagent, adds what only a human-facing review can judge, and drafts comments for the user to approve before anything is posted.
---

# Review a pull request

The checklist lives in one place: `.claude/agents/flowctl-reviewer.md`. This skill is the procedure around it.

1. **Read the PR:** `gh pr view <n>` (body, base, labels, linked issue), `gh pr diff <n> --name-only`, `gh pr checks <n>`.
   If CI is red or pending, report that first; do not review a red PR line by line.
2. **Run it locally:** the PR's own scripts, tests and config run with your environment, so look before you run.
   - `git fetch origin`, then `branch=$(gh pr view <n> --json headRefName -q .headRefName)`; never paste a branch
     name into a command by hand.
   - `git diff --name-only "origin/<base>...refs/remotes/origin/$branch" -- package.json bun.lock vitest.config.ts .githooks .claude scripts`:
     if anything is listed, **stop and show the user** those files before running anything.
   - Use a **separate clone**, never a worktree: a worktree shares `.git/config`, so a `git config` run by the
     PR's tests (`core.fsmonitor`, `core.hooksPath`) would keep running in the main checkout.
     `git clone --no-hardlinks --no-checkout . "../flowctl-review-<n>"`, then in it
     `git fetch origin "refs/remotes/origin/$branch" && git checkout --detach FETCH_HEAD` (its `origin` is your
     local checkout, which already fetched the PR branch).
   - In the clone: `bun install --frozen-lockfile --ignore-scripts && bun run verify`.

   A green CI run does not replace this when the PR touches browser behaviour. Delete the clone when done
   (`rm -r -f "../flowctl-review-<n>"`, which asks first).
3. **Checklist:** dispatch the `flowctl-reviewer` subagent on `origin/<base>..origin/<head>`. Do not re-run its
   checks yourself; read its findings and verify any you are going to repeat.
4. **What the subagent cannot judge:**
   - Does the PR do what its issue / acceptance criteria ask, and nothing unrelated?
   - Touches explore, replay or heal → is there a result of a trial on a real app in the body? If not, ask for one.
   - Golden file `__golden__/system1-request.json` changed → is there a contract-tier run and a new
     `docs/benchmarks/jev.jsonl` line?
   - Changes a contract (flow YAML, config, `--json`, exit codes, MCP results) → ADR and "Breaking changes" filled?
   - Stacked → base is the branch below, `status:stacked` label, "Stack: n/N" in the body.
5. **Draft the review.** One comment per finding, prefixed `blocker:`, `should-fix:` or `nit:`, with `file:line`, the
   rule it breaks, and the smallest fix. Separate verdict line: approve, comment, or request changes.
6. **Show the draft to the user and wait.** Only after a go: `gh pr review <n> --comment|--approve|--request-changes
   --body-file <draft>` (inline comments through `gh api` if asked). Never merge; merging is the user's action.
