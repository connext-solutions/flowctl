# @flowctl/cli (CLI)

The `flowctl` command. A thin layer over `@flowctl/core`: parse arguments, call the
core, print a summary, set the exit code.

```text
flowctl replay [name...] [--tag <tag>] [--env <env>] [--repeat <n>] [--heal [--accept-heals]] [--json] [--headed] [--trace safe|full] [--video] [--config <path>]
flowctl login <profile> [--env <env>] [--config <path>]
flowctl observe [--env <env>] [--profile <profile>] [--start <path>] [--json] [--out <file.json>] [--config <path>]
flowctl trust init [--replace] [--anchor-dir <abs dir>] [--config <path>]
flowctl trust hook <name...> [--hook-env NAME] [--pin NAME=VALUE] [--config <path>]
flowctl trust add env <env> [--config <path>]
flowctl trust key rotate-owner [--config <path>]
```

The full list, with every `trust add` kind, is `flowctl --help`.

Every command except `--help` and `trust init` is **guarded** (ADR 0025 section 3): it first checks that this
machine has a trust store and that the project and its flows directory are registered in it, and otherwise
exits `3` with `trust_missing` before touching any file. The list lives in `COMMANDS` in core.

| Exit code | Meaning |
|---|---|
| `0` | every run passed, or usage was requested with `--help` / `-h` as the first argument |
| `1` | a run failed or a flow is flaky |
| `2` | an infrastructure error (config, app unreachable, expired profile, System 1 unreachable, hooks without consent), or a usage error |
| `3` | a trust refusal: no store or project not registered (`trust_missing`), no terminal, tampered store, wrong passphrase, refused env name or class |

`--trace full` adds DOM snapshots to the traces (not safe to share, ADR 0030). `--video` records a demo video per
profile with each step shown on screen, slowed down to be read, and is refused for a flow with secret inputs (ADR
0032). Both print a warning on stderr.

`--json` prints the `ReplaySummary` from core; its shape and the exit codes are a contract for CI and
agents, so changing them is a breaking change.

`flowctl observe` (early) crawls the env read-only and writes the map to `appmap.json` in the run directory; `--out`
copies it to a `.json` path inside the flows directory (never under `.auth`), checked before the crawl starts. It
prints one line per page, or with `--json` a compact summary (`runId`, `status`, `pages`, `truncated`, `attention`:
pages with no answer, a 4xx/5xx or a refused request, `budget`, `file`). It exits `0` when the crawl finished and `2`
when the run ended in an error; a map is not a verdict, so it never exits `1`.

`flowctl login` opens a headed browser; finish with Enter in a terminal or by closing the window (the
only way without a TTY). It refuses to save a session that never left the login page.

`flowctl trust` changes this machine's trust store (ADR 0025) and only runs in an interactive terminal:
it reads every answer from `/dev/tty`, asks for a typed confirmation code, and never prompts through
stdin. `trust init` shows the config's envs and origins as candidates and asks the owner to type each env's
class (`production`, `shared` or `local`; Enter leaves the env out), the production origins (typed back
exactly), the default env (never a production one), the language and the locale; then it creates the owner key
and the store, with every entry signed. `trust add env <env>` classifies an env added to the config later. `trust hook` shows each flow's hook text and every file its hooks call, then signs a consent
for exactly those bytes; `--hook-env` lets a hook see one allowed variable (`PGPASSWORD`,
`PGCONNECT_TIMEOUT`, `PGAPPNAME`, `PGCLIENTENCODING`) and `--pin NAME=VALUE` fixes a `PGHOST`-style value.

## Adding a command

Register the command in `COMMANDS` (core `trust/commands.ts`) with its `guarded` flag, then add its argument
count and handler in `src/main.ts`, a row in `test/guard.test.ts` (it does not compile without one) and a case in
`test/cli.browser.test.ts`, which runs commands through the `cli()` helper with a test store. Business logic
belongs in core, not here.
