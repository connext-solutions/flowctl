# LLM agent with DevTools MCP vs flowctl explore and replay

A small, reproducible comparison of two ways to verify the same four flows of the fixture app
(`packages/fixture-app`), on the clean app and with each seeded bug: tokens and cost, speed, and whether the
verdict is right.

**Status: partial.** The Claude Code arm did not run. Its first call was refused by the model API
(`403 oauth_not_allowed_for_organization`: the Claude Code login on the benchmark machine could not use its
subscription), so the harness stopped it after that one call, as designed. The flowctl arms ran in full. Rerun
the LLM arm with a working login (see "Rerun") to complete the tables; nothing else needs to change. A second LLM
arm, Kiro CLI with the same DevTools MCP server, ran as a **3-case cost probe** only (one run each; see "Kiro CLI
arm").

## Arms

| Arm (`arm` in `results.jsonl`) | What runs | Verdict from |
|---|---|---|
| `llm-devtools` | headless Claude Code (`claude -p`) with only the Chrome DevTools MCP tools | the last line of its answer, `VERDICT: PASSED` or `VERDICT: FAILED`; anything else is `no_verdict` |
| `llm-kiro-devtools` | headless Kiro CLI (`kiro-cli chat --no-interactive`) with a dedicated agent that loads only the Chrome DevTools MCP server; probe only | the same last-line rule as `llm-devtools` |
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
| Kiro arm | Kiro CLI 3.5.0 (v3 engine), `--model claude-sonnet-5.5` (rate multiplier 1.30x credits in `kiro-cli chat --list-models`), the same `chrome-devtools-mcp@1.13.0` flags, 10 min wall-clock cap per run |
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
| llm-kiro-devtools | 3 | 3 | 100.0% | 0 | 0 | 0 | 46968 | 81555 | 4.255 credits total, 1.418 credits per run | context breakdown 12299 (tools 7993, prompts 4306, responses 0) | 26 |
| flowctl-explore | 4 | 0 | 0.0% | 0 | 0 | 4 | 2416 | 3078 | unknown (11 System 1 decisions, median 434 ms each) | unknown | 1 (flow_run) + flow_wait |
| flowctl-replay | 51 | 51 | 100.0% | 0 | 0 | 0 | 3604 | 5627 | $0 (no model) | 0 | 1 (flow_replay) |

### Per case

| Case | Expected | Arm | Verdicts | Correct | Median wall ms | p90 wall ms | Mean cost | Mean tool calls |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| leave-approve/clean | passed | flowctl-explore | escalated | 0/1 | 3036 | 3036 | unknown | 1.0 |
| leave-approve/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 2783 | 2991 | $0 | 1.0 |
| leave-persist/clean | passed | flowctl-explore | escalated | 0/1 | 3078 | 3078 | unknown | 1.0 |
| leave-persist/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 2291 | 2305 | $0 | 1.0 |
| leave-submit/clean | passed | llm-kiro-devtools | passed | 1/1 | 30878 | 30878 | 0.615 credits | 15.0 |
| leave-submit/clean | passed | flowctl-explore | escalated | 0/1 | 2416 | 2416 | unknown | 1.0 |
| leave-submit/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 729 | 743 | $0 | 1.0 |
| leave-validation/clean | passed | flowctl-explore | escalated | 0/1 | 2190 | 2190 | unknown | 1.0 |
| leave-validation/clean | passed | flowctl-replay | passed, passed, passed | 3/3 | 254 | 276 | $0 | 1.0 |
| leave-submit/save500 | failed | flowctl-replay | failed, failed, failed | 3/3 | 3624 | 3625 | $0 | 1.0 |
| leave-persist/notPersisted | failed | llm-kiro-devtools | failed | 1/1 | 46968 | 46968 | 1.068 credits | 22.0 |
| leave-persist/notPersisted | failed | flowctl-replay | failed, failed, failed | 3/3 | 5161 | 5196 | $0 | 1.0 |
| leave-approve/wrongBody | failed | llm-kiro-devtools | failed | 1/1 | 81555 | 81555 | 2.572 credits | 42.0 |
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

### Runs that ended in an error (excluded from the LLM arms; counted as not correct for flowctl)

| At | Arm | Case | Error | Wall ms |
| --- | --- | --- | --- | --- |
| 2026-11-20T15:14:17.073Z | llm-devtools | leave-submit/clean | 403 oauth_not_allowed_for_organization | 2247 |

### Kiro CLI arm (probe, one run per case)

| Case | Expected | Verdict | Credits | Wall ms | Turn ms (sum) | Turns | Tool calls | Context breakdown tokens | Tools / prompts / responses tokens | Model |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| leave-submit/clean | passed | passed | 0.615 | 30878 | 24904 | 1 | 15 | 12299 | 7993 / 4306 / 0 | claude-sonnet-5.5 |
| leave-approve/wrongBody | failed | failed | 2.572 | 81555 | 76555 | 1 | 42 | 12299 | 7993 / 4306 / 0 | claude-sonnet-5.5 |
| leave-persist/notPersisted | failed | failed | 1.068 | 46968 | 41542 | 1 | 22 | 12299 | 7993 / 4306 / 0 | claude-sonnet-5.5 |

Average 1.418 credits per run, average context breakdown 12299 tokens; 51 runs ≈ 72.3 credits.


### flowctl explore with System 1 (clean app, one run per flow)

| Flow | Status | Escalation | Steps | System 1 decisions | System 1 ms (sum) | Median decision ms | Wall ms | Model | Result bytes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| leave-approve | escalated | action_failed | 2 | 3 | 1603 | 434 | 3036 | unknown | 810 |
| leave-persist | escalated | low_confidence | 1 | 2 | 2675 | 1861 | 3078 | unknown | 745 |
| leave-submit | escalated | low_confidence | 2 | 3 | 1381 | 327 | 2416 | unknown | 722 |
| leave-validation | escalated | low_confidence | 2 | 3 | 2062 | 648 | 2190 | unknown | 683 |

flow_replay result size: median 515 bytes, max 701 bytes.

The LLM arm row is empty: its single call was refused before any token was used (`$0`), and refused calls are
not counted as runs. Total spend: **$0.00** reported by the Claude Code arm; **4.255 credits** by the Kiro arm; **11** System 1 decisions (cost unknown).

## Kiro CLI arm

**Method.** `node scripts/bench/compare.mjs --arm kiro` (`scripts/bench/compare-kiro.mjs`) writes the agent config
`~/.kiro/agents/flowctl-bench-devtools.json` (the CLI finds an agent by name only there or in `<cwd>/.kiro/agents`),
checks it with `kiro-cli agent validate`, then for each probe case starts a fresh fixture and runs

```sh
kiro-cli chat --no-interactive --output-format stream-json --model claude-sonnet-5.5 \
  --agent flowctl-bench-devtools --trust-tools=@chrome-devtools --require-mcp-startup "<prompt>"
```

in a fresh empty temp directory, with no System 1 key in the environment, and kills the process group after
10 minutes (recorded as `timeout`). The prompt is the same `promptFor` text as the Claude Code arm. The agent has
`tools` and `allowedTools` set to `@chrome-devtools` only, `includeMcpJson: false` (the user's MCP servers are not
loaded), no resources, no hooks, and a one-line prompt.

**Measures**, from the `stream-json` events: credits from the last `session_usage` event (`credits[].usage`),
turn time as the sum of `turn_completion` `elapsedTime`, turns as the number of `turn_completion` events, tool calls
as the number of `tool_call` updates, the context `breakdown` with the largest total (tools, prompts, responses),
the model from the session's model option, and the verdict from `runFinished.finalText` through the same
`parseVerdict`. `costUsd` is `null` and `costUnit` is `kiro-credit`: the CLI reports credits, not dollars.

**Probe.** Three cases, one run each, sequential: `leave-submit/clean` (expected `passed`) and two seeded bugs
in other flows, `leave-approve/wrongBody` and `leave-persist/notPersisted` (expected `failed`). Average
1.418 credits per run; at that rate **51 runs (17 cases × 3) ≈ 72.3 credits**. Three runs say little about
precision, and the cost per run varied 4× (0.615 to 2.572 credits) with the number of tool calls (15 to 42).

**Limits of this arm.**

- The v3 engine does not expose MCP tools directly. The model sees two built-in tools, `load_resource` and
  `tool_call`, and loads the DevTools tools through them (the `Tool Load` calls in `toolNames`, counted in the tool
  calls). The breakdown shows MCP tools at 0 tokens and built-in tools at 7,993 tokens.
- The breakdown lists 23 user-level skills (`~/.kiro/skills/*`) under `contextFiles` at 0 tokens each: the agent
  config cannot switch off the resource catalogue, so their names and descriptions are offered to the model through
  `load_resource` (inside the 7,993 built-in tokens, as far as the stream shows). `toolNames` shows only
  `Tool Load` and DevTools tools; the stream does not say which resource each `Tool Load` fetched.
- The v3 stream sends the breakdown at session start and turn end only, without tool results or responses, so
  `contextTokens` (12,299 in every run) is the fixed overhead, not the peak. `maxContextPercent` (the largest
  `usagePercentage` of the 1M window) is recorded from now on; the three probe lines predate it.
- The whole flow ran as one turn (`numTurns` 1): Kiro counts a turn per user prompt, not per model call, so this
  is not comparable with Claude Code's `num_turns`.
- With the v2 engine (`--agent-engine v2`) the model sees the 33 DevTools tools directly, but the stream carries
  only `meteringUsage` and a context percentage, without the breakdown; the probe used the default v3.

## Reading the numbers

- **Replay** gave the right verdict in 51 of 51 runs (17 cases × 3), with no false pass and no false fail, no
  model and no tokens. Clean runs take 0.25 to 3 s; a failing run takes about 3 s longer because each assertion
  waits `assertTimeout` (3 s) before it fails. The first failed assertion of every bug case is the one
  `CAUGHT_BY` pins.
- **Explore** escalated in 4 of 4 flows after 1 or 2 steps (three `low_confidence`, one `action_failed` in
  `leave-approve`), in 2.2 to 3.1 s with 2 or 3 System 1 decisions each (median decision 434 ms). Without an
  orchestrator to answer, none reached a verdict, so its precision here is 0 of 4. The flows that replay were
  written by hand; this run does not show that Jev alone would have produced them from these goals.
- **Kiro CLI with DevTools** gave the right verdict in 3 of 3 probe runs, in 31 to 82 s and 15 to 42 tool calls,
  at 0.615 to 2.572 credits per run. The same cases replay in 0.7 to 5.6 s with no model.
- **No comparison with the Claude Code arm is possible yet**: it has no runs.

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
node scripts/bench/compare.mjs --arm kiro         # billed in Kiro credits: the 3 probe cases once each (KIRO_BIN overrides the path)
node scripts/bench/compare.mjs --report           # the tables above, from results.jsonl
```

Every arm appends to `results.jsonl` and skips what is already there, so a rerun continues. Spend limits are
read from the lines already recorded: the LLM arm runs 3 probe cases first and stops if they average more than
$0.60 per run; after that at most 3 runs per case, 60 runs and $12 in total (it stops before a run that would
pass $12 at the average so far), and it stops at the first call the model API refuses. Explore runs once per
flow, with up to 2 retries in total when System 1 is unreachable. To start over, move `results.jsonl` away.

`results.jsonl` holds one line per run: `arm`, `case` (`<flow>/<clean|bug>`), `expected`, `rep`, `verdict`,
`correct`, `wallMs`, and per arm the CLI usage (`costUsd`, `inputTokens`, `outputTokens`, `cacheReadTokens`,
`cacheWriteTokens`, `durationMs`, `numTurns`, `toolCalls`; for the Kiro arm `credits`, `costUnit`,
`contextTokens`, `toolNames`), the System 1 figures (`decisions`, `system1Ms`,
`medianDecisionMs`, `escalation`), or the replay figures (`steps`, `failedAssertion`, `resultBytes`). No keys,
cookies or temp paths; run ids only.
