---
paths:
  - "packages/*/src/**"
---

# Reliability rules (errors, resources, output)

## Errors

- Throw typed errors, never strings: `ConfigError` (bad config), `FlowError` (bad flow file or name),
  `RunError` with a `kind` from `ErrorKind` (infrastructure during a run), `StepError` (a step could not run).
  Every kind a caller must handle is in the function's `@throws`.
- **Infrastructure is not a product bug.** App unreachable, expired profile, System 1 unreachable, a failing
  `setup` hook → `status: error` with a `hint` the user can act on. Only assertions produce `failed`.
- Never swallow an error. Catch only to convert it into a typed error or a result, and keep the message.
- Error messages say what to do next (`run flowctl login admin --env staging`), not just what broke.

## Resources

- Whatever is opened is closed in `finally`: browser contexts (through `RunSession.finish`), child processes, servers in tests.
- `teardown` always runs, even after a failure, an escalation that is abandoned, or a cancel.
- Every wait has a timeout from config (`stepTimeout`, `assertTimeout`, `navigationTimeout`, `hookTimeout`)
  or a named constant. Every loop has a bound (`maxSteps`, `LOOP_REPEATS`, `DONE_REJECTIONS`, `ATTEMPTS`).

## Output

- `core` never writes to stdout or stderr and never exits the process: it returns results and throws errors
  (`scripts/check-arch.mjs` enforces no `console.*` / `process.exit` in core). The CLI prints; the MCP server
  speaks only the protocol on stdout and logs to stderr.
- Diagnostics a person needs later go into the run's evidence (`run.json`, `decisions.jsonl`, network/console logs), not into a log line.
