---
inclusion: auto
name: ship-pr
description: Use before pushing a branch or opening a pull request in flowctl. Runs the local gates, fills the PR template truthfully, sets base, labels and stack position, and gets the user's go before anything is published.
---

# Ship a pull request

## Gates (all local, before push)

1. Not on `main`. Commits follow Conventional Commits (the `commit-msg` hook enforces it).
2. `bun run verify` green (the pre-push hook runs it too).
3. Secrets: `docker run --rm -v "$PWD:/repo" zricethezav/gitleaks:v8.30.1 detect --source /repo --log-opts=origin/<base>..HEAD --redact` finds nothing.
4. If the change touches System 1 prompts or protocol: contract tier run (billed, ask first) and the golden test diff explained.
5. If it touches exploration, replay or heal: a result of a trial on a real app, or say why not.

## The PR

1. Base: `main`, or the branch below it in a stack (`stack` skill).
2. Body: `.github/pull_request_template.md`, every section filled. Tick an invariant only if you checked it. No `Co-Authored-By` / "Generated with".
3. Labels: one `type:*`, every `area:*` touched, `phase:*` if planned work, `status:stacked` in a stack.
4. **Show the title and body to the user and wait for a go** before `git push` / `gh pr create`.
5. After creating: `gh pr checks <n> --watch`; a red CI is fixed on the branch, never by skipping a check.
