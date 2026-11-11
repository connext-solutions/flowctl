---
paths:
  - "**"
---

# Security rules

- The TypeSafe key lives only in `spike/.env` (gitignored) or the caller's environment
  (`TYPESAFE_API_KEY`). Never print it, echo it, put it in a command line, a test, a fixture or a log.
  Load it with `set -a; . spike/.env; set +a`.
- Login credentials never touch flowctl: profiles are saved by a person in `flowctl login`. Never commit
  `.flows/.auth/` or `.flows/.runs/`; never read `.auth` files into the conversation.
- System 1 runs only in `system1.allowedEnvs`; replay on any other env must not call a model (ADR 0005).
- Evidence must stay safe to attach to a bug: secret inputs show as `***` in `run.json`, decisions and reports.
- New dependencies: prefer none; justify any in the PR. `bun audit` runs in CI.

## Trust boundaries

- **Flow files are code.** `setup` and `teardown` run as shell commands with the caller's environment
  (`run/hooks.ts`, `trust/hookrun/`) from a snapshot with a built environment, and only after this machine's
  trust store holds an owner-signed consent for exactly those bytes (`flowctl trust hook`, ADR 0021, ADR 0025).
  Review flow changes like code; never run `flowctl trust` for the user (it refuses without a terminal anyway).
- **Names become paths.** A flow name is validated (`FlowSchema` name: lowercase letters, digits, dashes) before it
  becomes `<flowsDir>/<name>.yaml`; keep every user-supplied name or id that reaches the file system validated the same way.
- **Validate at the edge.** Config and flow YAML go through zod schemas; MCP tool arguments go through zod shapes.
  Inside core, trust the parsed types.
- **System 1 over HTTPS.** Real endpoints use `https://`; plain `http://` is only for the localhost fake in tests.
- **Evidence leaves the machine.** Anything written under `.runs/` may be attached to a bug: keep secrets out of it
  (`***`), and never write cookies or storage state there.

