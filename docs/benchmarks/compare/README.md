# LLM agent with DevTools MCP vs flowctl explore and replay

A small, reproducible comparison of two ways to verify the same four flows of the fixture app
(`packages/fixture-app`), on the clean app and with each seeded bug: tokens and cost, speed, and whether the
verdict is right.

**Status: partial.** The LLM arm did not run. Its first call was refused by the model API
(`403 oauth_not_allowed_for_organization`: the Claude Code login on the benchmark machine could not use its
subscription), so the harness stopped it after that one call, as designed. The flowctl arms ran in full. Rerun
the LLM arm with a working login (see "Rerun") to complete the tables; nothing else needs to change.

## Arms

| Arm (`arm` in `results.jsonl`) | What runs | Verdict from |
|---|---|---|
| `llm-devtools` | headless Claude Code (`claude -p`) with only the Chrome DevTools MCP tools | the last line of its answer, `VERDICT: PASSED` or `VERDICT: FAILED`; anything else is `no_verdict` |
| `flowctl-explore` | `Exploration` with the real TypeSafe Jev System 1, the request built from the flow file (goal, start, profile, inputs, assertions); no orchestrator answers an escalation | the flow's assertions (an escalation is not a verdict) |
| `flowctl-replay` | `replayMany` on the fixture's saved flow YAML, no model | the flow's assertions |

## Cases and ground truth

17 cases: each of the four flows on the clean app (expected `passed`), and each of the 13 seeded bugs
(`BUG_MODES`) in the flow that catches it (expected `failed`), as pinned by `CAUGHT_BY` in
`packages/core/test/seeded-bugs.accuracy.test.ts` and the fixture README table. Every run gets a fresh
fixture (`startFixture(mode)`) and an empty store (`POST /api/__reset`). Runs are sequential.

## Conditions

| | |
|---|---|
| Date | 2026-11-20 |
| Machine | Apple M5, 24 GB, macOS 26.5.2, Google Chrome 157.0.8103.79 (LLM arm), Playwright 1.63.0 Chromium (flowctl) |
| Node | 22.22.2 |
| flowctl | 0.3.0 (this repo at `main` 406814c), core built output |
| LLM arm | Claude Code 2.1.329, `--model sonnet`, `--max-turns 30`, `--max-budget-usd 1` per run; `chrome-devtools-mcp@1.13.0` with `--headless --isolated --no-usage-statistics --no-performance-crux --maxNavigationSaved 25 --viewport 1280x720` |
| System 1 | TypeSafe Jev at `https://api.typesafe.ai` (`jev-latest`), `assertTimeout` 5000 ms as in the contract tier |
| Replay | `assertTimeout` 3000 ms, `stepTimeout` 3000 ms, as in the accuracy tier |

## Fairness choices and their limits

- **Same task.** The LLM prompt is generated from the flow YAML (`scripts/bench/compare-prompt.mjs`): the start
  URL with the run's base URL, every step in order, and every assertion as an expectation (network checks over
  the whole flow, page checks on the final page). `{{uid}}` becomes a fresh tag per run. `--dry-run` prints all
  17 prompts.
- **Same login.** flowctl starts from storage states saved through `/login?as=<profile>`; the LLM prompt gives
  the same URL pattern and starts with signing in. A profile switch in a flow (`as: manager`) becomes "open
  `/login?as=manager`, then the page".
- **Same browser view of the traffic.** `--maxNavigationSaved 25` (the maximum) keeps the requests and console
  messages of earlier pages, so the agent can check network and console expectations across the whole flow
  as flowctl does; with the default (3) it would lose the POST of `leave-approve` before the end.
- **Isolated agent.** No built-in tools (`--tools ""`), only the DevTools server (`--strict-mcp-config`,
  `--allowedTools mcp__chrome-devtools`, `--disallowedTools Bash Edit Write`), no user or project settings
  (`--setting-sources ""`), no slash commands, an empty working directory, and no System 1 key in its
  environment. The default Claude Code system prompt is kept: that is the agent a user runs.
- **Wall time** is measured around the work only: the whole `claude` process for the LLM arm (CLI start, MCP
  server start, Chrome launch), `Exploration.start` plus `advance` for explore, and `replayMany` (including its
  browser launch) for replay. Fixture start and profile seeding are outside for all arms.
- **Replay goes through the core API**, not the `flowctl replay` binary: the CLI needs a trust store created
  interactively (`flowctl trust init`). `replayMany` is the function both the CLI and the MCP `flow_replay` call.
- **Coding-agent side of flowctl** counts as one tool call (`flow_run` or `flow_replay`). The MCP server answers
  `flow_run` asynchronously, so a real agent also calls `flow_wait` at least once, and answers escalations with
  `flow_step`. `resultBytes` is the size of the JSON the MCP tool would return (`progressView` / `replayView`).
- **Explore has no orchestrator.** In the intended loop a coding agent answers System 1's escalations. Here
  nobody does: an escalation is recorded and the run is closed with `finish()`. The explore goals are the flow
  files' goals, which describe outcomes ("after a successful submit ..."), not actions; the contract tier's
  passing goal is an instruction ("fill the reason, then press Gửi").

## Results

### Overall

| Arm | Runs | Correct | Precision | False pass | False fail | No verdict / error / escalated | Median wall ms | p90 wall ms | Cost | Tokens (mean per run) | Agent tool calls (mean) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| llm-devtools | 0 | 0 | - | 0 | 0 | 0 | - | - | - | - | - |
| flowctl-explore | 4 | 0 | 0.0% | 0 | 0 | 4 | 2416 | 3078 | unknown (11 System 1 decisions, median 434 ms each) | unknown | 1 (flow_run) + flow_wait |
| flowctl-replay | 51 | 51 | 100.0% | 0 | 0 | 0 | 3604 | 5627 | $0 (no model) | 0 | 1 (flow_replay) |

### Per case

| Case | Expected | Arm | Verdicts | Correct | Median wall ms | p90 wall ms | Mean USD | Mean tool calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| leave-approve/clean | passed | flowctl-explore | escalated | 0/1 | 3036 | 3036 | unknown | 1.0 |
| leave-approve/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 2783 | 2991 | $0 | 1.0 |
| leave-persist/clean | passed | flowctl-explore | escalated | 0/1 | 3078 | 3078 | unknown | 1.0 |
| leave-persist/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 2291 | 2305 | $0 | 1.0 |
| leave-submit/clean | passed | flowctl-explore | escalated | 0/1 | 2416 | 2416 | unknown | 1.0 |
| leave-submit/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 729 | 743 | $0 | 1.0 |
| leave-validation/clean | passed | flowctl-explore | escalated | 0/1 | 2190 | 2190 | unknown | 1.0 |
| leave-validation/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 254 | 276 | $0 | 1.0 |
| leave-submit/save500 | failed | flowctl-replay | failed, failed, failed | 3/3 | 3624 | 3625 | $0 | 1.0 |
| leave-persist/notPersisted | failed | flowctl-replay | failed, failed, failed | 3/3 | 5161 | 5196 | $0 | 1.0 |
| leave-approve/wrongBody | failed | flowctl-replay | failed, failed, failed | 3/3 | 5627 | 5628 | $0 | 1.0 |
| leave-submit/toastOnFail | failed | flowctl-replay | failed, failed, failed | 3/3 | 3588 | 3723 | $0 | 1.0 |
| leave-validation/noValidation | failed | flowctl-replay | failed, failed, failed | 3/3 | 3271 | 3291 | $0 | 1.0 |
| leave-approve/consoleError | failed | flowctl-replay | failed, failed, failed | 3/3 | 2757 | 2761 | $0 | 1.0 |
| leave-persist/list500 | failed | flowctl-replay | failed, failed, failed | 3/3 | 5229 | 5244 | $0 | 1.0 |
| leave-persist/wrongValueAfterReload | failed | flowctl-replay | failed, failed, failed | 3/3 | 5257 | 5275 | $0 | 1.0 |
| leave-approve/approve403 | failed | flowctl-replay | failed, failed, failed | 3/3 | 5587 | 5730 | $0 | 1.0 |
| leave-approve/approveNoop | failed | flowctl-replay | failed, failed, failed | 3/3 | 5804 | 5838 | $0 | 1.0 |
| leave-submit/redirectWrong | failed | flowctl-replay | failed, failed, failed | 3/3 | 3534 | 3719 | $0 | 1.0 |
| leave-submit/formNotReset | failed | flowctl-replay | failed, failed, failed | 3/3 | 3817 | 3818 | $0 | 1.0 |
| leave-submit/toastInList | failed | flowctl-replay | failed, failed, failed | 3/3 | 3590 | 3595 | $0 | 1.0 |

### Runs that ended in an error (excluded from the LLM arm; counted as not correct for flowctl)

| At | Arm | Case | Error | Wall ms |
| --- | --- | --- | --- | --- |
| 2026-11-20T15:14:17.073Z | llm-devtools | leave-submit/clean | 403 oauth_not_allowed_for_organization | 2247 |

### flowctl explore with System 1 (clean app, one run per flow)

| Flow | Status | Escalation | Steps | System 1 decisions | System 1 ms (sum) | Median decision ms | Wall ms | Model | Result bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| leave-approve | escalated | action_failed | 2 | 3 | 1603 | 434 | 3036 | unknown | 810 |
| leave-persist | escalated | low_confidence | 1 | 2 | 2675 | 1861 | 3078 | unknown | 745 |
| leave-submit | escalated | low_confidence | 2 | 3 | 1381 | 327 | 2416 | unknown | 722 |
| leave-validation | escalated | low_confidence | 2 | 3 | 2062 | 648 | 2190 | unknown | 683 |

flow_replay result size: median 515 bytes, max 701 bytes.


The LLM arm row is empty: its single call was refused before any token was used (`$0`), and refused calls are
not counted as runs. Total spend: **$0.00** reported by the LLM arm; **11** System 1 decisions (cost unknown).

## Reading the numbers

- **Replay** gave the right verdict in 51 of 51 runs (17 cases × 3), with no false pass and no false fail, no
  model and no tokens. Clean runs take 0.25 to 3 s; a failing run takes about 3 s longer because each assertion
  waits `assertTimeout` (3 s) before it fails. The first failed assertion of every bug case is the one
  `CAUGHT_BY` pins.
- **Explore** escalated in 4 of 4 flows after 1 or 2 steps (three `low_confidence`, one `action_failed` in
  `leave-approve`), in 2.2 to 3.1 s with 2 or 3 System 1 decisions each (median decision 434 ms). Without an
  orchestrator to answer, none reached a verdict, so its precision here is 0 of 4. The flows that replay were
  written by hand; this run does not show that Jev alone would have produced them from these goals.
- **No comparison of the two approaches is possible yet**: the LLM arm has no runs.

## Caveats

- Small N: 3 runs per case, 17 cases, one explore per flow.
- One app, made for flowctl's tests: its labels, roles and seeded bugs match what flowctl asserts. An app with
  harder controls would cost both arms more.
- Jev's token cost is not reported by its API (`unknown`); only decision counts and round-trip times are.
- The LLM arm's cost is the `total_cost_usd` the CLI reports, an estimate at API prices, also under a
  subscription login.
- The LLM arm wall time includes `npx` resolving `chrome-devtools-mcp` (cached after the first run) and the
  CLI's own start.
- Explore runs were closed on escalation and their run directories removed with the temp config; only the
  escalation reason was kept (the harness now also keeps the sanitised escalation detail).

## Rerun

Opt-in only; it never runs in CI or `bun run verify`. From the repo root, after `bun install` and
`bun run build`:

```sh
node scripts/bench/compare.mjs --dry-run          # print the 17 LLM prompts, no browser, no model
node scripts/bench/compare.mjs --arm replay       # free: 3 replays per case
set -a; . spike/.env; set +a; node scripts/bench/compare.mjs --arm explore   # billed System 1, once per flow
node scripts/bench/compare.mjs --arm llm          # billed: needs a working `claude` login (CLAUDE_BIN overrides the path)
node scripts/bench/compare.mjs --report           # the tables above, from results.jsonl
```

Every arm appends to `results.jsonl` and skips what is already there, so a rerun continues. Spend limits are
read from the lines already recorded: the LLM arm runs 3 probe cases first and stops if they average more than
$0.60 per run; after that at most 3 runs per case, 60 runs and $12 in total (it stops before a run that would
pass $12 at the average so far), and it stops at the first call the model API refuses. Explore runs once per
flow, with up to 2 retries in total when System 1 is unreachable. To start over, move `results.jsonl` away.

`results.jsonl` holds one line per run: `arm`, `case` (`<flow>/<clean|bug>`), `expected`, `rep`, `verdict`,
`correct`, `wallMs`, and per arm the CLI usage (`costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `durationMs`, `numTurns`, `toolCalls`), the System 1 figures (`decisions`, `system1Ms`,
`medianDecisionMs`, `escalation`), or the replay figures (`steps`, `failedAssertion`, `resultBytes`). No keys,
cookies or temp paths; run ids only.
