---
paths:
  - "packages/cli/**"
---

# CLI rules

- Exit codes are a contract: `0` passed, `1` failed or flaky, `2` infrastructure error, `3` a trust refusal
  (`trust_missing`, tampered store, no terminal for `flowctl trust`). CI and agents branch on them.
  The one exception: `--help` or `-h` as the first argument prints usage on stdout and exits `0`
  (the runtime load check runs each bin as `--help` and requires `0`). Anywhere else they are unknown
  options and exit `2`; a missing or invalid command also exits `2`.
- `--json` output is the core `ReplaySummary`, unchanged. Changing its shape is a breaking change (PR template).
- The CLI parses, calls core, formats. Logic that a second caller (MCP) would need belongs in core.
- Human output goes to stdout; diagnostics to stderr. Never prompt when stdin is not a TTY.
