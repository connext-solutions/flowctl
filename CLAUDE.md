@AGENTS.md

## Claude Code specifics

- Path-scoped rules live in `.claude/rules/` and load when you touch matching files.
- Skills: new or large work → `superpowers:brainstorming` then `superpowers:writing-plans`; code →
  `superpowers:test-driven-development`; structure discussions use the `mattpocock-skills:codebase-design`
  vocabulary (module, interface, seam, adapter, depth — see `CONTEXT.md`).
- Look code up with codegraph first, grep second.
- Hooks (`.claude/settings.json`, scripts in `.claude/hooks/`):
  - `guard-bash` denies `bun --bun`, `bun test`, `--no-verify`, force push and printing `.env`; asks before
    `git reset --hard`, `rm -rf` and pushing to main.
  - `dup-export` rejects an `export` whose name another `packages/*/src` file already exports. If the clash
    is unrelated, put `// dup-ok: <reason>` on the line above the export.
  - `format-file` runs oxfmt + oxlint on each edited `.ts` file; lint errors come back to you.
  - `stop-check` runs `bun run check` before you stop when `packages/` or `scripts/` changed; fix what it reports.
