# Harness deny rules for the trust store (T0.17)

Owner decision 2026-11-06: agents on a flowctl machine get deny rules for the trust store
(`~/.config/flowctl`, which also holds the default `sessionDir`), the owner-key directory
(`~/.config/flowctl-owner-key`) and the user settings files, anchored in **managed settings outside the
repository** (ADR 0025 section 6). A repository file cannot remove a managed deny, and a deny in any scope wins.

Install once per machine, as an administrator (Claude Code reads this path on macOS; on Linux it is
`/etc/claude-code/managed-settings.json`):

```bash
sudo mkdir -p "/Library/Application Support/ClaudeCode"
sudo cp docs/setup/claude-managed-settings.json "/Library/Application Support/ClaudeCode/managed-settings.json"
```

Check it took effect: in a new Claude Code session, `/permissions` lists the deny rules as managed. Keep
`CLAUDE_CONFIG_DIR` unset, so the user settings the rules protect are the ones Claude Code reads.

Limits:

- `Bash(...)` deny rules are friction, not a control: a command can reach the same files another way. The real
  protection is that only `flowctl trust ...`, run by a person on a terminal, changes the store, and that every
  read verifies the owner-key signatures.
- These rules are specific to Claude Code. Kiro and other agents need their own rule; the `.kiro/hooks`
  `guard-bash` adapter blocks `flowctl trust` and reads of `.auth` files, but it lives in the repository.
- flowctl itself still reads the store; the rules stop the agent's own file tools, not flowctl.
