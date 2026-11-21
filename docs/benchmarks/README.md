# System 1 benchmarks

`jev.jsonl` gets one line per task each time the contract tier runs
(`set -a; . spike/.env; set +a; bun run test:contract`). It is how we notice that TypeSafe changed
`jev-latest` or that a prompt edit made decisions worse. Commit the new lines with the change that
produced them.

| Field | Meaning |
|---|---|
| `at`, `task` | when, and which contract task (fixture app, local) |
| `model` | model reported by System 1 (`unknown` if the task did not pass) |
| `status`, `steps`, `wallMs` | exploration outcome, actions executed, wall time including the browser |
| `decisions`, `medianDecisionMs` | System 1 calls and their median round trip |
| `blockedTop` | decisions whose most likely operation was `BLOCKED` |

Baseline before this log existed (spike 2026-10-03, ERP local trials 2026-10-06): ERP tasks 18/18 passed
without escalation, 240–415 ms per decision, holiday create flow 10 steps in 12.4 s; `BLOCKED` probability
0.16–0.19 on the unnamed holiday-type combobox.

Remote observation (ERP **stg** read-only trial 2026-11-03, work-schedules roster, not the contract tier):
System 1 round trip **~10.4–10.9 s per decision**, 25–40× the local 240–415 ms. This is the real TypeSafe
endpoint against a remote app under load, not the local fake; it is a data point for the "fast" story, not a
regression in the engine. The flow passed deterministically in 4.6 s with **0** System 1 decisions once the
assertions matched real traffic (a passing exploration need not call the model at all). Source: trial run
`r_mw08us1071ea` (local, gitignored).

| Trial run (stg, 2026-11-03) | Outcome | System 1 decisions | Round trip per decision (ms) | Wall time |
|---|---|---|---|---|
| `r_mw08dykg1a9b` | escalated (abandoned, no `run.json`) | 3 | 10870, 10448, 10372 | not recorded |
| `r_mw08sxgdae59` | failed (wrong network path in the assertion) | 3 | 10683, 10774, 10424 | 49.4 s for 2 steps |
| `r_mw08us1071ea` | passed | 1 (436 ms) | 436 | 4.6 s, 0 steps |

What it means for users: on stg, plan for about 10 s per System 1 decision, so a 10-step exploration takes
about two minutes, while replaying the saved flow takes seconds with no model. The fast path is assertions
that already hold (no decision) and replay. Worth asking TypeSafe whether the stg-facing endpoint can be
faster; re-measure after any change.

Contract tier, 2026-11-11, untrusted-data framing in every question (issue #48): lines at 06:22:46 to 06:23:09 are
`main` before the change (2 runs), the rest are the change (3 runs). The leave form passed 5/5 with 2 or 3 steps and
3 or 4 decisions on both. The Enter-only todo task escalated 5/5 on both (`done_rejected` after three `DONE`, or one
`BLOCKED` or low-confidence decision): System 1 answers `DONE` once the field shows the value and never presses
Enter, before and after the change, so the change did not cause it.

Contract tier, 2026-11-21, issue #4 (Enter-only todo task). The request after typing offered `PRESS_ENTER`, but its
text spoke of "the focused field" while the snapshot marks no field as focused, and only search fields were said to
need submitting; the field value `Mua sữa` was the only place the goal's words appeared, a likely reason for `DONE`. The
change says a typed value is not added or saved until submitted (a button naming the goal's action, otherwise
`PRESS_ENTER`), that a field's current value is not evidence for `DONE`, and describes `PRESS_ENTER` as submitting
the value just typed. Lines at 07:13:13 to 07:24:27 are five Enter-task runs while the wording was tuned: two with
a first draft of the field rule, one with the committed rule and the old `PRESS_ENTER` text, one with the committed
wording (07:23:53), and one with an extra Search/Submit edit that was then dropped. The five leave-form lines after
them use the committed wording. Before (2026-11-11 lines and issue #4): `DONE`, `BLOCKED` or `CLICK` came first after
typing. After: in the first two runs `CLICK` on the `Lưu nháp` (save draft) button came first (p 0.42, `PRESS_ENTER`
0.37 in the one logged), in the last three `PRESS_ENTER` came first (p 0.30, 0.42, 0.41) with `CLICK` on `Lưu nháp`
second and `DONE` at 0.10 to 0.19. Every run still escalated as `low_confidence` (threshold 0.5), so the task is
still 0/5; the leave form stays 5/5 (3 steps, 4 decisions).

## LLM agent vs flowctl

`compare/` holds an opt-in comparison of a headless LLM agent driving the Chrome DevTools MCP against flowctl
explore and replay on the fixture app's flows (verdict correctness, speed, tokens and cost): method, results
and how to rerun in [`compare/README.md`](compare/README.md), harness in `scripts/bench/compare.mjs`.
