# flowctl

Fast, deterministic verification of web flows for developers and testers who work through coding agents
(Claude Code, Kiro, Codex).

- **Fast:** a recorded flow replays in about a second with no model. A new flow is explored by a fast
  "System 1" model, so the coding agent spends one call instead of twenty.
- **Accurate:** the verdict comes only from assertions written before the run (network status and request
  body, visible text, URL, field values, console errors), never from a model's opinion.
- **Reliable:** strict locators, assertions that wait, and evidence for every run (Playwright trace,
  screenshot, network and console logs) that is safe to attach to a bug.

> **Early preview.** The engine, the CLI and the MCP server work and are tested, but the interfaces may still
> change between releases. One safety limit is not finished: **replaying a saved flow is not guarded against
> destructive requests** on a shared env (exploration is; production is refused for both). Run flowctl only
> against apps and environments you are allowed to change.

## How it works

A *flow* is a YAML file: a start page, a profile (a saved login), steps, and assertions. flowctl runs it in
Playwright and returns `passed`, `failed`, `flaky` or `error`.

1. **Explore.** Given a goal, a start page and the assertions, System 1 (by default TypeSafe Jev) reads a
   snapshot of the page and picks the next control. When it is stuck or unsure it *escalates* to the coding
   agent, which answers once. A model's "done" only stops the run; the assertions decide the verdict.
2. **Save.** A passed exploration becomes a flow only after a model-free replay of the recording passes.
3. **Replay.** Saved flows replay with no model, in CI or locally. `flowctl replay --heal` may ask System 1 to
   repair one broken locator, never an assertion, and writes the fix only with `--accept-heals`.

Design decisions are recorded in [docs/adr/](docs/adr/README.md); the vocabulary is in [CONTEXT.md](CONTEXT.md).

## Status

Latest release: [v0.1.0](https://github.com/connext-solutions/flowctl/releases/tag/v0.1.0) (pre-release).

| Area | State |
|---|---|
| Model-free replay, CLI, evidence safe to share (ADR 0030) | done |
| Exploration with System 1, escalations, save after a confirming replay, opt-in heal | done |
| MCP server for coding agents and its playbook (ADR 0027) | done |
| Trust store, hook consent, scope guard, production hosts unreachable (ADR 0021, 0024, 0025) | done |
| Destructive-action guard for exploration: labels and the request layer | done |
| Wall-clock budget per run (`budget_exceeded`) | done |
| Demo videos of a replay with a step overlay (ADR 0032) | done |
| Destructive-action guard for **replay** on shared envs, stored confirmations and the run ledger | open |
| Read-only replay on production, computed System 1 cost | open |
| Observe: read-only crawler and `AppMap` (`flowctl observe`, ADR 0033) | early |
| Free checks on the map, Derive (test cases from specs), Reconcile (classify failures) | planned |

Bugs and proposals: [issues](https://github.com/connext-solutions/flowctl/issues).

## Install

Requires Node 22.12+. Releases are published on
[GitHub Releases](https://github.com/connext-solutions/flowctl/releases), not on npm (ADR 0031). Install a
release by its URL (replace `0.1.0` with the release you want):

```bash
npm install --save-dev https://github.com/connext-solutions/flowctl/releases/download/v0.1.0/flowctl-cli-0.1.0.tgz
npx playwright install chromium
npx flowctl --help
```

The MCP server is `flowctl-mcp-<version>.tgz` and the engine `flowctl-core-<version>.tgz` from the same
release; each tarball pulls the matching core release by itself.

### From source

Requires [Bun](https://bun.sh) as the package manager as well.

```bash
git clone https://github.com/connext-solutions/flowctl.git && cd flowctl
bun install
bunx playwright install chromium
bun run build
cd packages/cli && bun link    # puts `flowctl` on your PATH
```

**Apple Silicon with an x86_64 Bun (Rosetta).** If Bun prints `CPU lacks AVX support`, or `bun run lint`
fails with `Cannot find module '@oxlint/binding-darwin-arm64'`, install the native arm64 Bun, delete
`node_modules` and run `bun install --frozen-lockfile`; or keep your Bun and run
`bun install --frozen-lockfile --cpu=arm64 --os=darwin` with an arm64 Node 22 first on `PATH`.

## Try it on the fixture app

`packages/fixture-app` is a small two-role app with seeded bugs; the test suite uses it as ground truth.
`bun run verify` builds everything and runs the unit, browser and accuracy tiers against it (about 10 minutes).
Sample flows live in `packages/fixture-app/flows/`.

## Quickstart on your app

1. Create `flowctl.config.yaml` in the repo that will own the flows:

   ```yaml
   flowsDir: .flows            # may point into another repo, e.g. ../qa-tests/flows
   defaultEnv: local
   envs:
     local:   { baseUrl: http://localhost:4200, loginUrl: /login }
     staging: { baseUrl: https://staging.example.com, loginUrl: /login }
   profiles:
     employee: { locale: en-US }
     manager:  { locale: en-US }
   system1:
     baseUrl: https://api.typesafe.ai
     allowedEnvs: [local, staging]   # System 1 only runs here; never list a production env
   target:                     # optional; every key can only narrow what the trust store allows
     scope:
       allow: [/app/**]        # paths on the env's own origin
       deny:  [/admin/**]      # added to the built-in deny list
   ```

   Every run also has a wall-clock budget, `target.budgets.wallClockMs` (10 minutes, the default and the
   maximum): when it runs out the run is stopped mid-step and ends `error: budget_exceeded`.

   Every request, page and frame a run opens is checked against the scope; one outside it is stopped before it
   leaves the browser and the run ends `error: scope_violation`. A run never saves a download: the browser cancels
   it, `network.json` notes it as `DOWNLOAD <url>`, and only a download from outside the scope fails the run.
   WebRTC and WebTransport are disabled in run pages (best effort: a worker keeps WebTransport), so no verdict
   rests on them. If your app calls an API or SSO on another origin,
   allow it once per machine: `flowctl trust add origin <env> call https://api.example.com`.

2. Create this machine's trust store (once, interactive). You type each env's class (`production`, `shared`
   or `local`), the production origins, the default env, the language and the locale, then a passphrase for
   your owner key. The folder that holds `flowctl.config.yaml` must be a git repository with at least one commit.

   ```bash
   flowctl trust init
   ```

   Every command except `--help` and `trust init` refuses with exit code 3 (`trust_missing`) until this is done.
   The store intersects every run with what you recorded: an env runs only on its recorded origin, System 1
   stays off envs not classed `local` or `shared`, and limits cannot be loosened past the built-in ceilings.
   `flowctl trust --help` lists the other commands (another project, env, origin, secret input names, key
   rotation, hook consent).

3. Save a session per profile and env. You log in by hand in the browser; credentials never touch flowctl:

   ```bash
   flowctl login employee --env local
   ```

4. Write a flow (`.flows/leave-approve.yaml`; a full example is
   `packages/fixture-app/flows/leave-approve.yaml`) and replay it:

   ```bash
   flowctl replay                        # every flow, default env
   flowctl replay leave-approve --env staging
   flowctl replay --tag smoke --repeat 5 # flake check
   flowctl replay --json                 # machine-readable summary
   ```

Add `<flowsDir>/.runs/` and `<flowsDir>/.auth/` to your `.gitignore`.

## Use flowctl from a coding agent (MCP)

The MCP server (`packages/mcp`, bin `flowctl-mcp`) lets Claude Code, Kiro or Codex test a feature end to end:
System 1 drives the browser toward a goal, the agent answers escalations, the run is judged only by the
assertions the agent wrote from the spec, and a passed run is saved as a flow. Setup, the tool reference and
the limits are in [packages/mcp/README.md](packages/mcp/README.md); the agent playbook is
[packages/mcp/skill/SKILL.md](packages/mcp/skill/SKILL.md).

Exploration needs a System 1 key (`TYPESAFE_API_KEY`) in the environment of the client that starts the
server. Replay never needs it. Never put the key in a config file, a chat or a command line.

On an env classed `shared`, System 1 never clicks a control named like delete, approve, reject or pay, and the
run blocks any request that looks destructive (any `DELETE`, or a path such as `/items/12/delete`) unless the
agent started it with `allowDestructive: true`. On `production`, and on any origin the trust store does not
list, nobody may.

## Observe (early)

`flowctl observe` maps an app without a model: it opens the env's start page (or `--start <path>`) with a saved
profile (`--profile`, the first one by default), then visits the same-origin links breadth-first, in sorted order.
It never clicks, types or submits, and only reads leave the browser, on every env class: any other method, and any
`GET` whose path looks destructive (`/items/purge`), is aborted. It does not follow links out of the `visit` scope,
links that open a new window or a download, the login page, or links whose label or path looks destructive
(ADR 0033).

```bash
flowctl observe --start /home --env staging [--json] [--out .flows/maps/app.json]
```

The map (`appmap.json` in the run directory, and a copy at `--out`, which must be inside the flows directory) lists,
per page: path, document status, title, the controls of the page snapshot, forms with their fields (label, type,
required, submit), links, fetch/xhr calls (method, path, status) and console errors, with credential-looking text as
`***`, and the requests refused while the page was open. It stops at `target.budgets.pages` (at most 50) or the
run's wall-clock budget, then says `truncated`. Exit `0` when the crawl finished (a map is not a verdict), `2` on an
error. Free checks on the map (broken links, 5xx, console errors) are not built yet.

## Flow format

Steps: `click | check | hover | fill | select | press | goto | reload | wait | scroll | upload | drag`, and
`as: <profile>` to switch role. A locator must match exactly one visible element. An `upload` file lives under
`<flowsDir>/fixtures/` (at most 10 MiB). Templates: `{{uid}}`, `{{today}}`, `{{today+1:DD/MM/YYYY}}` and
`{{env.NAME}}` from the env's `vars`; write `{{lbrace}}` for a literal `{{`.

Assertions: `network` (fetch/xhr only; `status`, `requestBody` subset, `absent`), `text` (case-sensitive;
`within: <locator>` holds it to one element), `url`, `value`, `noConsoleErrors`. Assertions wait up to
`assertTimeout` (10 s). Secret inputs (`{ env: NAME }`, allowed per profile with
`flowctl trust add profile <profile> <NAME> secret`) show as `***` everywhere.

`setup` and `teardown` hooks are shell commands; they run only after you consent on this machine with
`flowctl trust hook <name>`, and only while their text and the files they call are unchanged (ADR 0021).

## Results

Exit codes: `0` all passed · `1` failed or flaky · `2` error (setup, session, config, hooks without consent,
a guard that stopped the run, the wall-clock budget) · `3` a trust refusal. Every `error` has a `kind` and a `hint`
that says what to do; the kinds are listed in [CONTEXT.md](CONTEXT.md#error-kinds).

Evidence per run is in `<flowsDir>/.runs/<runId>/`: `trace-<profile>.zip` (open with
`npx playwright show-trace <file>`), `final.png`, `network.json`, `console.json`, `run.json`, and for runs that
ask System 1, `decisions.jsonl`. By default the trace records actions, timings, URLs and console output but no
DOM, headers, cookies or bodies, and secret values show as `***` (ADR 0030). `flowctl replay --trace full` adds
DOM snapshots for debugging; never share that trace.

**Demo videos.** `flowctl replay <flow> --video` records `video-<profile>.webm` per profile, with a box that shows
each step before it runs, a cursor on its target, and the result at the end (ADR 0032). The box is invisible to
assertions and locators. Steps are slowed down so they can be read, and a flow with a secret input is refused:
a video cannot hide what is typed. Review a video before you share it.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), [AGENTS.md](AGENTS.md) (commands, invariants, where to change what) and
[CONTEXT.md](CONTEXT.md). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## Licence

Apache-2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
