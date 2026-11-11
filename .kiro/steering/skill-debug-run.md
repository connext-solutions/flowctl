---
inclusion: auto
name: debug-run
description: Use when a flowctl run failed, escalated, errored or looks wrong, or replay is flaky. Reads the run's evidence in a fixed order and classifies the cause as product bug, flowctl bug, System 1 mistake, flaky, wrong assertion, or infrastructure.
---

# Debug a run

Evidence is in `<flowsDir>/.runs/<runId>/`.

## Read in this order

1. `run.json` — `status`, `failed` (assertion + `got`, or step + kind), `escalation` (reason + controls), `error.kind`, `healed`, `weakLocators`, `teardownFailed`.
2. `decisions.jsonl` (explore/heal) — per step: ranked ops with probabilities, chosen control, `outcome`. Look for low `p`, `BLOCKED`, repeated identical actions, rejected `DONE`.
3. `network.json` and `console.json` — 4xx/5xx with bodies, matched requests, JS errors.
4. `final.png` (and failure screenshots). `report.html` once the report (T7.1) exists.
5. Only then the trace: `bunx playwright show-trace <dir>/trace-<profile>.zip`.

## Classify

| Signal | Likely cause | Next step |
|---|---|---|
| `error.kind` set | Infrastructure (`app_unreachable`, `profile_expired`, `system1_unreachable`, `setup_failed`) | Start the app, `flowctl login`, check network/key, fix the hook. Never report as a product bug |
| `error.kind` `flow_invalid` / `system1_not_allowed` / `hooks_untrusted` / `env_not_allowed` | The flow file or request (bad YAML, template, a navigation off the env origin), an env not in `system1.allowedEnvs`, hooks without consent on this machine, an `{ env }` input not allowed for the profile | Fix the flow; add the env to `allowedEnvs` only if it is not production; ask the user to run `flowctl trust hook <name>` or `flowctl trust add profile <profile> <NAME> secret` (never run either yourself) |
| `error.kind` `internal` | A flowctl bug or a crashed browser | Read `error.hint`; reproduce; file it as a flowctl bug, never a product bug |
| Exit code 3 (`trust_missing`, `trust_tampered`, …) | No trust store, project not registered, or a store changed outside flowctl | Ask the user to run `flowctl trust init` (never run it yourself) |
| Escalated `destructive_action` | System 1 (or the orchestrator) reached a delete/approve-like control on a shared env | Intended? Restart with `allowDestructive` on data the run created; otherwise hint away from it |
| `network` assertion got a 4xx/5xx | Product bug, or test data | Reproduce by hand or with the API; read the response body in `network.json` |
| `network` matched nothing | Request not sent, different URL, or not fetch/xhr | `failed.got` ends with `seen: METHOD /path, ...` (the requests the run made); compare the glob with it and `network.json`; check the step that should send it |
| `text`/`value` failed, network fine | Timing, wrong page, or wrong expectation | Check `assertTimeout`, the final URL, and the expectation against the source of truth (spec, AC, diff) |
| Escalated `BLOCKED` / `low_confidence` | Unnamed control or ambiguous goal | `weakLocators`; give a `hint` or a directed step; consider adding a label/testId to the app |
| Escalated `loop` / `done_rejected` | Ambiguous labels, or assertions the flow cannot reach | Read the repeated decision; re-check that every assertion is reachable by the goal |
| Replay step: 0 or >1 matches | UI changed | `--heal`, then review the YAML diff |
| Different statuses across `--repeat` | Flaky: race, shared data, animation | Make data unique (`{{uid}}`), add a wait-free assertion, never add sleeps |

**Never change an assertion to match what the run observed.** Change it only when the source of truth says the expectation was wrong, and say so.
