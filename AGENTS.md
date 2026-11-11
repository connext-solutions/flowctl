# AGENTS.md — flowctl

flowctl lets coding agents (Claude Code, Codex) verify frontend flows fast and deterministically:
a fast "System 1" model drives the browser, the agent only steps in when it escalates, and the verdict
comes from deterministic assertions plus a Playwright trace. Recorded flows replay without any model.

- Vocabulary: [CONTEXT.md](CONTEXT.md) · Decisions: [docs/adr/README.md](docs/adr/README.md)
- Status: phase 1 (model-free replay + CLI), phase 2a (exploration engine: System 1 client, snapshot,
  recorder, explore loop, save, heal) and the MCP server with its agent playbook (`packages/mcp`, ADR 0027) done;
  early preview.

## High-level design

Read this before changing anything structural. (`CLAUDE.md` imports this file, so Claude Code sees it too.) Vocabulary: `CONTEXT.md`. Decisions: `docs/adr/`.

**What flowctl is.** A verification engine for web flows. A *flow* is a YAML file. A *run* executes it in Playwright
and returns a verdict that comes only from deterministic assertions (network, text, URL, field value, console errors).
A model never decides pass or fail.

**Two layers today.**
1. *Replay* (model-free): `flow/` parses YAML, `browser/` executes steps with strict locators, `run/` owns the run
   (`RunSession`: contexts per profile, evidence, `run.json`), `verifier` checks assertions.
2. *Exploration* (System 1): a fast model (TypeSafe Jev) picks the next operation and control from a page snapshot
   (`system1/`, `explore/`). The coding agent (System 2, you) only handles escalations. A recording becomes a flow only
   after a model-free confirming replay passes (`save.ts`). `replay --heal` asks System 1 to fix one broken locator,
   never an assertion.

**Where it is going:**
`target.yaml` (URL, credential references, scope) → **Observe** (deterministic crawler → AppMap) + **SpecProvider**
(business operations from markdown or a spec plugin) → **Derive** (join them into test cases; every
assertion carries a `sourceRef` to spec text or a deterministic observation, never model-invented; human review gate)
→ **Execute** (existing replay and exploration, System 1 behind a pluggable `Driver`) → **Reconcile** (match failures
to code and issues; classify product bug, spec drift, stale test, environment; issues are drafted, never auto-filed).

**Rules that shape new code.**
- The invariants in `AGENTS.md` hold for every new module; the verdict rule (ADR 0004) is the one most likely to
  be broken by generation features.
- The core stays free of app-specific code. Adapters for one company or app live in plugins (`packages/plugin-*`
  or another repo); `scripts/check-arch.mjs` forbids core, cli and mcp from importing a plugin.
- Credentials are referenced by name and never reach a model, a prompt, a log or evidence.
- Packages: `core` (engine), `cli` (`flowctl`), `mcp` (`flowctl-mcp`, the agent entry), `fixture-app` (test app with seeded bugs; the accuracy ground truth).
  New capability goes into `core` behind an `index.ts` interface first, CLI and MCP are thin callers.

## Repo map

| Package | Owns | Interface | May depend on |
|---|---|---|---|
| `packages/core` (`@flowctl/core`) | config, flow format, RunSession, evidence, verifier, executor, snapshot + recorder, System 1 client, exploration, save, heal, replay, login, observe (read-only crawler, `AppMap`) | `src/index.ts` | npm deps only |
| `packages/cli` (`@flowctl/cli`, bin `flowctl`) | `flowctl replay`, `flowctl login`, `flowctl observe`, `flowctl trust` | `src/index.ts` (`main`, `formatSummary`), `src/bin.ts` | `core` |
| `packages/mcp` (`@flowctl/mcp`, bin `flowctl-mcp`) | MCP stdio server: `flow_run`, `flow_step`, `flow_wait`, `flow_save`, `flow_replay`, each guarded; agent playbook in `skill/` | `src/index.ts` (`createServer`), `src/bin.ts` | `core` |
| `packages/fixture-app` | two-role test app, 12 seeded bugs, sample flows | `src/index.ts` | nothing (tests only) |

Inside `core`: `flow/` (schema, steps, templates, store), `run/` (RunSession, outcome, evidence,
verifier, hooks), `browser/` (locator, executor, snapshot, recorder), `system1/` (protocol, prompts,
client), `explore/` (Exploration, run view, policy, act, heal). `save.ts` writes recordings. Each
folder exports through its `index.ts`.

## Commands

Node 22.22.2 is the runtime; Bun is only the package manager and script runner (ADR 0018).
Agent shells start fresh: prefix commands with `. ~/.nvm/nvm.sh && nvm use >/dev/null &&`.

| Task | Command |
|---|---|
| Setup | `nvm use && bun install && bunx playwright install chromium` |
| Setup on Apple Silicon with an x86_64 Bun | `bun install --frozen-lockfile --cpu=arm64 --os=darwin`, or install the native arm64 Bun (see README "Install") |
| After every change | `bun run check` (Node guard, architecture gate `scripts/check-arch.mjs`, harness tests, lint, format, typecheck, the runtime load check `scripts/check-bundle-plugins.mjs` (about 4 s alone), unit tests; measured 1 to 3 minutes on a loaded laptop, of which the harness tests, mostly the bundle-check ones (about 55 s alone), are the bulk) |
| Before saying "done" / before push | `bun run verify` (check + browser + accuracy tiers; about 10 min locally, the same as CI; ADR 0028) |
| One tier | `bun run test:unit` · `bun run test:browser` · `bun run test:accuracy` |
| One file | `bun run test -- packages/core/test/flow.test.ts` |
| Build | `bun run build` (`tsc -b`; emits `packages/*/dist`) |
| Run the CLI | `node packages/cli/dist/bin.js replay --config <path>` |
| Fix formatting | `bun run fmt` |
| Real System 1 (billed, opt-in) | `set -a; . spike/.env; set +a; bun run test:contract` |

Never use `bun --bun` or `bun test`: Playwright under the Bun runtime is flaky (ADR 0018).

## Invariants (never break)

1. A verdict comes only from deterministic assertions; a model's `DONE` is a stop signal, never a verdict (ADR 0004).
2. Replay never calls a model unless heal is explicitly on (`--heal`); replay locators must match exactly one element (ADR 0008, 0009).
3. `network` assertions only see fetch/xhr; assertions poll up to `assertTimeout`; evidence starts before a context's first navigation (ADR 0010).
4. Secret values never reach a model: secret inputs go as key names, their values become `***`; other inputs send a preview (ADR 0006).
5. System 1 (exploration and heal) runs only in `system1.allowedEnvs`; secret input values never reach it (ADR 0005, 0006).
6. Everything about browser contexts of a run goes through `RunSession`.

## Workflow

- New feature or structural change: brainstorm → spec → plan. Per-feature specs and plans are internal working
  docs: keep them out of git and never link them from committed files. Lasting decisions go to `docs/adr/`.
- Language: English for everything committed; Vietnamese only as product data (UI labels, fixture pages, test strings).
- Code: test first (TDD). Browser behaviour is tested against `fixture-app`, never with Playwright mocks.
- Run `bun run check` after each change and `bun run verify` before reporting completion.
- Commits: Conventional Commits; no `Co-Authored-By` or "Generated with" lines. Hooks run `check` on commit, the message format on `commit-msg`, and `verify` on push; do not pass `--no-verify` unless the user asks.
- A new design decision gets a new ADR in `docs/adr/`; an `active` ADR is never edited, it is superseded.
- PRs follow `.github/pull_request_template.md`; label them from `.github/labels.tsv` (`type:*`, `area:*`, `phase:*`). CI runs the same `verify` on every PR, plus gitleaks (blocks) and `bun audit` (report only).

## Skills (procedures)

Claude Code loads these automatically; other agents read the file when the task matches.

| Skill | Use when |
|---|---|
| [extend-engine](.claude/skills/extend-engine/SKILL.md) | adding a step/assertion kind, System 1 op, config key, CLI command, MCP tool, public export |
| [seeded-bug](.claude/skills/seeded-bug/SKILL.md) | adding an assertion kind or proving a defect class is caught |
| [debug-run](.claude/skills/debug-run/SKILL.md) | a run failed, escalated, errored or is flaky |
| [write-adr](.claude/skills/write-adr/SKILL.md) | a design decision is made or reversed |
| [ship-pr](.claude/skills/ship-pr/SKILL.md) | before pushing or opening a PR |
| [stack](.claude/skills/stack/SKILL.md) | stacked branches: create, update, merge bottom-up |
| [review-pr](.claude/skills/review-pr/SKILL.md) | reviewing someone's PR: CI, local verify, reviewer subagent, draft for approval |

Review: the `flowctl-reviewer` subagent (`.claude/agents/flowctl-reviewer.md`) checks a diff against the
invariants and ADRs; use it after each task, separate from the agent that wrote the code.

## Where to change what

Package-specific recipes and gotchas live next to the code: [packages/core/AGENTS.md](packages/core/AGENTS.md),
[packages/fixture-app/AGENTS.md](packages/fixture-app/AGENTS.md), [packages/cli/README.md](packages/cli/README.md).

| Change | Touch |
|---|---|
| New CLI command | `COMMANDS` in `core/src/trust/commands.ts` (with `guarded`) + `cli/src/main.ts` + a row in `cli/test/guard.test.ts` + `cli/test/cli.browser.test.ts` |
| New package | `packages/<name>` with `package.json` + `tsconfig.json` (composite), `README.md`, and `AGENTS.md` + `CLAUDE.md` (`@AGENTS.md`) if it has its own rules; add to root `tsconfig.json` references and `tsconfig.tests.json` paths / `vitest.config.ts` alias if tests import it by name; add it to `PACKAGE_DEPS` and `PACKAGE_NAMES` in `scripts/check-arch.mjs`; write an ADR. Only a test-only, source-only package (fixture-app) skips the tsconfig and build, see its AGENTS.md |

## Code conventions

TypeScript strict with `noUncheckedIndexedAccess`; no `any`; avoid `as` (`as const` is fine); `??` over `||`;
relative imports with `.js` inside a package, package names across packages, never deep imports;
files under 250 lines (300 max); a folder only when it holds ≥ 3 files; dates only via dayjs.
No inline comments: context goes in JSDoc with tags (`@throws`, `@example`, `@see`, `@remarks`);
exceptions are the `oxlint-disable` and `dup-ok` directives.
Details live in path-scoped rules (`.claude/rules/`, loaded by Claude Code when matching files are touched;
other agents read them directly): `architecture`, `typescript`, `comments`, `testing`, `performance`,
`reliability`, `security`, `system1`, `cli`, `ci`, `docs`, `flows`.
