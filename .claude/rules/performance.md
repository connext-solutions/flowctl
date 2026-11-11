---
paths:
  - "packages/**"
---

# Performance rules

flowctl's first promise is "fast". These budgets come from the design goals and the measured baseline;
a change that moves a number past its budget says so in the PR, with the measurement.

| What | Budget | Measured today | Where to see it |
|---|---|---|---|
| Replay of a saved flow | ≤ 15 s | 0.4–1.3 s per fixture/ERP flow | `run.json` `ms`, CLI summary |
| Explore a new flow | ≤ 60 s | 12.4 s for a 10-step ERP write flow | `run.json`, `decisions.jsonl` |
| System 1 decision | — | 240–415 ms round trip locally, about 10 s on ERP stg | `decisions.jsonl` `ms`, `docs/benchmarks/README.md`, `docs/benchmarks/jev.jsonl` (written by the contract tier on its first run) |
| Snapshot sent to System 1 | ≤ 6,000 chars of text | capped in `snapshot-script.ts` | golden test |
| Escalation control table | ≤ 40 rows (`MAX_CONTROLS`) | — | `explore/run-view.ts` |
| Result returned to an orchestrator | about 0.5 KB, never a DOM or accessibility tree | — | MCP / `--json` output |
| `bun run check` / `bun run verify` | 1–3 min / about 10 min locally | — | hooks, CI |

- **No fixed sleeps.** Wait on a condition with Playwright auto-wait or a bounded poll. The few deliberate waits
  (`WAIT` op, `wait` step, snapshot settle, fill settle, verifier and client polling) are listed in
  `scripts/check-arch.mjs` (`SLEEP_ALLOWED`); a new one needs a reason there.
- **One browser, many contexts.** Reuse the caller's browser; open a context per run/profile through `RunSession`, never a browser per step.
- **No extra round trips.** One snapshot per decision, one System 1 request per decision (heal: one per broken step). Re-snapshot only when the page changed (stale control).
- **Keep payloads small.** Anything that goes to System 1 or back to the orchestrator is trimmed at the source (text cap, control cap, compact summaries).
- **Tests stay fast.** Unit tier has no browser; browser tests reuse one fixture server per file; no test sleeps longer than the behaviour it waits for.
