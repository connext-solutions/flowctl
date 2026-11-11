# @flowctl/core

The flowctl engine: everything except the command line and the MCP transport.

- **Replay** a recorded flow with no model and decide the verdict from assertions (`replayFlow`, `replayMany`, `summarize`, `exitCodeFor`).
- **Explore** a new flow with a System 1 model driving the browser and the orchestrator stepping in on escalation (`Exploration`; the System 1 driver comes from `createDriver`, `System1Client.fromConfig` is its deprecated name), then **save** it after a confirming model-free replay (`saveExploration`).
- **Heal** a broken locator during replay with one System 1 question (opt-in).
- **Demo video** of a replay (`replayFlow(cfg, flow, { browser, video: true })`): one `video-<profile>.webm` per
  profile with a step overlay that assertions cannot see (ADR 0032).
- **Wall-clock budget:** every `RunSession` stops at `target.budgets.wallClockMs` and ends `budget_exceeded`;
  `run.signal` aborts with it (pass it to anything that can stop early).
- **Config, flows, login:** `loadConfig`, `findFlows`, `findFlowsWithErrors`, `loadFlow`, `login`.
- **Running a flow:** `RunSession` drives one run: profile contexts, `perform(step)`, `snapshot()`, `check()`, evidence and hooks, `finish()`. Replay and exploration are loops on top of it.

The interface is `src/index.ts`; nothing else is public. Result types are in `src/result.ts`.

## Tests

```bash
bun run test -- packages/core/test/flow.test.ts            # one unit file
bun run test:browser -- packages/core/test/replay.browser.test.ts
bun run test:accuracy                                       # seeded bugs
set -a; . spike/.env; set +a; bun run test:contract   # real Jev, billed, opt-in; key from spike/.env
```

Browser tests run against `@flowctl/fixture-app`; exploration tests use its scripted fake System 1.

`src/browser/snapshot-script.ts` and the prompts in `src/system1/prompts.ts` are adapted from jev-ultrafast (MIT);
see `THIRD_PARTY_NOTICES.md`.
