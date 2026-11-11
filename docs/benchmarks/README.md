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
