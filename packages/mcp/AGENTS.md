# AGENTS.md — packages/mcp

Read the root [AGENTS.md](../../AGENTS.md) first. This package is the MCP stdio server (ADR 0012, ADR 0027).

- **stdout is the protocol.** Nothing but JSON-RPC may reach stdout: diagnostics go to stderr (`onError` in
  `bin.ts`), and core never prints. `--help` is the only exception, before the transport starts.
- **Every tool is guarded.** A new tool is first added to `COMMANDS` in `core/src/trust/commands.ts` as
  `mcp <tool>` with `guarded: true`, then registered through `tool()` in `src/server.ts`, which runs
  `requireTrust` before the handler. `server.browser.test.ts` pins the tool list to the registry.
- **Validation lives in core.** Tool schemas only shape the arguments; requests and steps are checked by
  `parseExploreRequest` / `Exploration.step`. Never pass a `{ env }` input or hook text through a tool.
- **Answers stay small and marked.** Build results in `src/shape.ts`: a `next` field, `PAGE_DATA_NOTE` wherever
  page text appears, `pageText` on page-derived strings.
- **Runs are bounded.** `src/runs.ts` owns waiting (`WAIT_MS`), the slot limit (`MAX_RUNS`), the idle sweep and
  failures; test it with `runs.test.ts` (fake timers), not with a browser.
