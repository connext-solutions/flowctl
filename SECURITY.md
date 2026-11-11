# Security

flowctl drives browsers with real sessions, runs flow hooks as shell commands and sends page text to a model, so a
flaw here can leak credentials or let a pull request act on a shared env. Report one privately.

## Reporting

- Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a
  vulnerability**. Do not put exploit details in a public issue or pull request.
- Say what you saw, on which commit, and the smallest steps that show it. A proof that runs against the fixture app
  (`packages/fixture-app`) is best; never test against an env you are not allowed to change.
- Fixes ship as a normal pull request with a `type:security` label; details are published once the fix is merged.

## What is safe to attach

| Safe | Not safe: describe it, do not attach it |
|---|---|
| `run.json`, `decisions.jsonl`, the CLI summary, `--json` output | `.flows/.auth/` (saved sessions: they log anyone in as that profile) |
| Flow YAML files without real values | A trace recorded with `--trace full`: its DOM snapshots hold whatever the pages showed (the default trace has none, ADR 0030) |
| Screenshots of the fixture app | Your trust store (`~/.config/flowctl`) and owner key (`~/.config/flowctl-owner-key`) |
| | Any API key, including `TYPESAFE_API_KEY` |

Secret inputs are masked as `***` in run evidence (ADR 0006), but masking is a safety net, not a guarantee: check
before you attach.

## Secrets in the repository

CI runs gitleaks on every pull request (the `Security` workflow; it blocks the merge). If you committed a secret,
rotate it at once: removing it from git history does not make it secret again.

## Scope

In scope: everything in this repository, its CI workflows and the `.claude/` and `.kiro/` harness that agents run.
The design rules a report is checked against are the invariants in `AGENTS.md`, `.claude/rules/security.md` and the
trust model of ADR 0025 (section 6 says what it does not protect against, such as a same-user process with a shell).
