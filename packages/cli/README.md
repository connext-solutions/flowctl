# @flowctl/cli (CLI)

The `flowctl` command. A thin layer over `@flowctl/core`: parse arguments, call the
core, print a summary, set the exit code.

```text
flowctl replay [name...] [--tag <tag>] [--env <env>] [--repeat <n>] [--heal [--accept-heals]] [--json] [--headed] [--trace safe|full] [--video] [--config <path>]
flowctl login <profile> [--env <env>] [--config <path>]
flowctl cleanup <run id> [--json] [--config <path>]
flowctl observe [--env <env>] [--profile <profile>] [--start <path>] [--json] [--out <file.json>] [--config <path>]
flowctl reconcile <run id> [--code <dir>] [--appmap <file>] [--spec <dir>] [--json] [--config <path>]
flowctl reconcile --gaps [--code <dir>] [--appmap <file>] [--spec <dir>] [--out <dir>] [--json] [--config <path>]
flowctl trust init [--replace] [--anchor-dir <abs dir>] [--config <path>]
flowctl trust hook <name...> [--hook-env NAME] [--pin NAME=VALUE] [--config <path>]
flowctl trust add env <env> [--config <path>]
flowctl trust key rotate-owner [--config <path>]
flowctl trust key new --person <name> --scope flows|spec --expires <days> [--out <file>] [--config <path>]
flowctl trust key add <public key file> --person <name> --scope flows|spec --expires <days> --custody hardware|file [--config <path>]
flowctl trust key revoke <key id> [--reason <text>] [--config <path>]
flowctl trust add destructive <flow> --env <env> --from-run <run id> [--days <n>] [--config <path>]
flowctl trust add destructive --renew <id>... | --renew-env <env> [--days <n>] [--config <path>]
flowctl trust revoke destructive <id> [--config <path>]
```

The full list, with every `trust add` kind, is `flowctl --help`.

Every command except `--help` and `trust init` is **guarded** (ADR 0025 section 3): it first checks that this
machine has a trust store and that the project and its flows directory are registered in it, and otherwise
exits `3` with `trust_missing` before touching any file. The list lives in `COMMANDS` in core.

| Exit code | Meaning |
|---|---|
| `0` | every run passed, or usage was requested with `--help` / `-h` as the first argument |
| `1` | a run failed or a flow is flaky; for `observe`, a free check failed; never for `reconcile` |
| `2` | an infrastructure error (config, app unreachable, expired profile, System 1 unreachable, hooks without consent, a `ledger_*` error), a run that left records it created on a shared env (`cleanup_incomplete`), or a usage error |
| `3` | a trust refusal: no store or project not registered (`trust_missing`), no terminal, tampered store, wrong passphrase, refused env name or class |

`--trace full` adds DOM snapshots to the traces (not safe to share, ADR 0030). `--video` records a demo video per
profile with each step shown on screen, slowed down to be read, and is refused for a flow with secret inputs (ADR
0032). Both print a warning on stderr.

`--json` prints the `ReplaySummary` from core; its shape and the exit codes are a contract for CI and
agents, so changing them is a breaking change.

`flowctl cleanup <run id>` removes the records a replay on a shared env created and could not remove itself (a
crash, a timeout): it reads only that run's ledger in the trust store (`<store>/ledgers/<run id>.jsonl`, hash chain
verified), sends each stored create entry's `cleanup` request with the flow profile's saved session, checks it with
the `verify` request, and appends the result to the ledger, so it can run again and skips what is confirmed. A
create whose answer never came is listed by name, never deleted by name. It holds the run's lock
(`<store>/ledgers/<run id>.lock`) while it runs: while a live run or another cleanup of the same run holds it, it
refuses with `ledgers_invalid` detail `busy` and exits `3`, sending nothing; a lock left by a flowctl process that is
gone is taken over and reported as `staleLock` (in `--json`, and as a warning line). When a result line cannot be
written to the ledger (a full disk), it still cleans the other ids, reports the error as `writeFailed`, and lists
each id confirmed deleted but not recorded as leftover `unrecorded`; the next cleanup sends its cleanup again. It
exits `0` when nothing is left, else `2` (a torn last line, `writeFailed`, or any leftover); a run id that is not `r_`
plus 1 to 32 lowercase letters or digits is a usage error.

`flowctl observe` (early) crawls the env read-only and writes the map to `appmap.json` in the run directory; `--out`
copies it to a `.json` path inside the flows directory (never under `.auth`, `.git` or `.runs`, and never over a file
that is not a map), checked before the crawl starts. It then runs the free checks on the map and writes `checks.json`
beside it. It prints one line per page, the checks' verdict and up to 20 findings, or with `--json` the core
`ObserveSummary` (`runId`, `env`, `origin`, `pages`, `truncated`, `error` when the run ended in one, `attention`: at
most 20 pages with no answer, a 4xx/5xx or a refused request, `checks`: status, failed check ids, finding count and
file, `budget`, `file`, `out`). It has no top-level `status`, since a map is not a verdict; the checks are. It exits
`0` when the crawl finished and every check passed, `1` when a free check failed, and `2` when the run ended in an
error (no checks are run then; ADR 0033, amendment).

`flowctl reconcile <run id>` (early) classes a failed or errored run of this project as `product_bug`,
`spec_drift`, `stale_test`, `environment` or `unknown` (ADR 0036): it reads `.runs/<run id>/run.json` (the id is checked
before it becomes a path; no symlink is followed), and optionally a code index of `--code <dir>`, an `AppMap`
(`--appmap <file>`, inside the flows directory) and a markdown spec folder (`--spec <dir>`, whose operation with the
flow's name as its `id` is used, or none, with a note). `--code` and `--spec` must be inside the project root until
`trust add root` exists. It prints the class, the confidence, each hit it stands on with its reason and evidence
pointers (escaped), and writes `classification.json` into the run directory; `--json` prints the core
`Classification`. `flowctl reconcile --gaps` writes the coverage gaps between the code, one crawl (`--appmap`, or the
latest run's `appmap.json`) and the spec as `gaps.json` and `gaps.md` into `--out <dir>` (default `<flows>/gaps`,
contained like `observe --out`, never over a file that is not a gaps report), and prints a count per checked kind and
the kinds not checked (ADR 0037). Both are advice, never a verdict: they exit `0` whenever they ran and `2` on a usage,
config or containment error (ADR 0036 and 0037, amendments 2026-11-12).

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

`trust add destructive <flow> --env <env> --from-run <run id>` lets a replay of that flow write on a shared env
(ADR 0024 section 5). Replay the flow on a `local` env first; the command reads that passing run's `network.json`
and turns each write into a proposed entry (method, URL template with ids as `{int}` or `{uuid}`, content type, body
keys, query keys). It shows the env, the flow and every file its confirmation digest binds, the effective vars and
the recorded writes (paged, invisible characters escaped), then asks only what no recording holds: the kind
(`create`, `mutate` or skip), `nameField`, `naturalKeys`, `conflictStatus`, `idFrom` (default `body:/id`), the
cleanup and verify templates, `ledgerFrom` and `idPositions`, each with a default you accept with Enter. The
entries are printed last in the fixed line format, then the nonce and the owner-key passphrase. They expire after
`--days` (default 30, at most 90) and stop matching as soon as the flow, a file it uses or a var it reads changes.
`--renew <id>...` gives unchanged flows a new expiry; `--renew-env <env>` re-binds an env's entries to the origin
the store now records.

## Adding a command

Register the command in `COMMANDS` (core `trust/commands.ts`) with its `guarded` flag, then add its argument
count and handler in `src/main.ts`, a row in `test/guard.test.ts` (it does not compile without one) and a case in
`test/cli.browser.test.ts`, which runs commands through the `cli()` helper with a test store. Business logic
belongs in core, not here.
