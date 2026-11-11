# `.kiro` — Kiro configuration (converted from `.claude`)

This directory mirrors the project's Claude Code configuration (`.claude/`) in the formats Kiro
understands. The `.claude/` directory is kept as-is (Claude Code still uses it via `CLAUDE.md`); this
is the Kiro-native equivalent. Where a concept has no direct Kiro counterpart, it is noted below.

## What maps to what

| `.claude/` | `.kiro/` | Notes |
|---|---|---|
| `rules/*.md` (frontmatter `paths:`) | `steering/*.md` with `inclusion: fileMatch` + `fileMatchPattern` | Multiple paths become one brace glob `{a,b}`. `security.md` used `paths: **` → `inclusion: always`. |
| `skills/*/SKILL.md` (on-demand, `description`) | `steering/skill-*.md` with `inclusion: auto` + `name`/`description` | Kiro activates these on demand when the request matches the description, the same trigger model as Claude skills. Helper files (scripts, templates) stay in `.claude/skills/...`; the steering files point at those paths. |
| `agents/flowctl-reviewer.md` | `agents/flowctl-reviewer.json` | Tool names translated to Kiro's (`read_file`, `grep_search`, `execute_bash`, …). Rule references repointed to `.kiro/steering/`. |
| `settings.json` → `hooks` | `hooks/*.json` + `hooks/scripts/*.mjs` | See "Hooks" below. |
| `settings.json` → `permissions` | (no structural equivalent) | See "Permissions" below. |

## Steering (rules + skills)

- Always-on: `security.md`.
- Path-scoped (`fileMatch`): `architecture`, `ci`, `cli`, `comments`, `docs`, `flows`, `performance`,
  `reliability`, `system1`, `testing`, `typescript`.
- On-demand (`auto`, one per Claude skill): `skill-debug-run`, `skill-extend-engine`,
  `skill-review-pr`, `skill-seeded-bug`, `skill-ship-pr`,
  `skill-stack`, `skill-write-adr`.

**Do not edit `steering/` by hand.** The sources are `.claude/rules/*.md` and `.claude/skills/*/SKILL.md`;
the steering files are generated from them, so a rule or skill changes in one place:

```sh
node .kiro/sync.mjs           # regenerate .kiro/steering after changing a rule or skill
node .kiro/sync.mjs --check   # exit 1 and list the files that are stale or have no source
```

## Hooks

Each Claude hook has a Kiro hook JSON in `hooks/` and a Node adapter in `hooks/scripts/` that reads
Kiro's stdin/env shape and reuses the original logic.

| Kiro hook | Trigger / matcher | Does |
|---|---|---|
| `guard-bash.json` | `PreToolUse` / `execute_bash` | Imports `decide()` from `.claude/hooks/guard-bash.mjs`. Blocks rule-breaking commands (deny → exit 2), asks before destructive ones. |
| `dup-export.json` | `PreToolUse` / `fs_write\|str_replace\|fs_append` | Refuses a new `export` already exported under `packages/*/src` (exit 2). Escape hatch: `dup-ok: <reason>`. |
| `format-file.json` | `PostToolUse` / `fs_write\|str_replace\|fs_append` | Runs oxfmt (silent) and oxlint (errors to stderr) on edited `packages/*/{src,test}/**.ts`. |
| `stop-check.json` | `Stop` | Runs `bun run check` when `packages/`, `scripts/` or `package.json` are dirty; blocks the stop on failure (exit 2). |

Differences from Claude Code to be aware of:

- **Matchers test Kiro tool names.** Claude's `Bash` → Kiro's `execute_bash`; Claude's `Write|Edit` →
  Kiro's `fs_write|str_replace|fs_append`.
- **No project-dir env var.** Kiro does not export a `CLAUDE_PROJECT_DIR` equivalent, and hook commands
  run from the workspace root. So the hook JSON calls the scripts by a relative path
  (`node .kiro/hooks/scripts/…`), and the adapters take the project root from `process.cwd()` (they still
  honour `KIRO_PROJECT_DIR` if a future Kiro sets it).
- **PreToolUse deny.** Kiro's strongest PreToolUse decision is `ask` (prompt the user), not a hard
  `deny`. The adapters emit `permissionDecision: ask` and also exit 2 so the tool is blocked.
- **`format-file` fires on agent edits.** Mapped to `PostToolUse` on the write tools so it runs after the
  agent edits, matching the original `PostToolUse(Write|Edit)` behaviour. For formatting on a human save
  instead, change the trigger to `PostFileSave`.

## Permissions (not converted structurally)

`.claude/settings.json` declared a Bash allow-list and `Read` deny globs. Kiro manages tool trust and
per-command approval through its own UI, so there is no file to port these to. The intent is preserved
here and enforced in two other places:

- **Never read** `.env` files, `**/.flows/.auth/**`, `**/flows/.auth/**` or any `**/.auth/**/*.json`
  (live cookies / the TypeSafe key). The `guard-bash` hook and the `security` steering file enforce this.
- The allow-list was the set of safe project commands (`bun run check|verify|test:*|lint|fmt|build`,
  `node packages/cli/dist/bin.js …`, `git status`, `gh pr|run|issue view/checks/list`). Treat these as
  pre-approved; everything else is subject to the `guard-bash` rules.
