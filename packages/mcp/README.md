# @flowctl/mcp

The flowctl MCP server: lets a coding agent (Claude Code, Kiro, Codex) explore a web flow with System 1
(TypeSafe Jev), answer its escalations, save the result as a flow, and replay saved flows. The verdict always
comes from the flow's assertions, never from a model (ADR 0004). Design: ADR 0012 and ADR 0027.

## Run it

Install it from a release (`npm install https://github.com/connext-solutions/flowctl/releases/download/v0.2.0/flowctl-mcp-0.2.0.tgz`;
the bin is then `node_modules/@flowctl/mcp/dist/bin.js`), or build it from a checkout (`bun install && bun run
build`; the bin is `packages/mcp/dist/bin.js`). Then register the server with your client; the paths below use the
checkout form. It needs the same things as the CLI: a `flowctl.config.yaml`, a trust store with the project
registered (`flowctl trust init`), and saved sessions (`flowctl login <profile> --env <env>`). Exploration
also needs the System 1 key in the server's environment (the variable named by `system1.apiKeyEnv`, default
`TYPESAFE_API_KEY`) and the env in `system1.allowedEnvs`.

The server does not read `spike/.env`. It gets the key only from the environment its client starts it with:

- A client started from a terminal (the `claude` CLI, `kiro-cli`) passes on that shell's exports, so run
  `set -a; . /abs/path/flowctl/spike/.env; set +a` (or export the key in your profile) before starting it.
- A client started from the Dock or an IDE does not see your shell profile; set the key in the client's
  MCP `env` instead (below), referencing a variable rather than writing the key.
- `node` on the client's `PATH` must be Node 22 (`nvm alias default 22` if you use nvm), or put the full path
  of a Node 22 binary in `command`.

Claude Code:

```bash
claude mcp add --scope user flowctl -- node /abs/path/flowctl/packages/mcp/dist/bin.js \
  --config /abs/path/to/flowctl.config.yaml
```

Kiro (`~/.kiro/settings/mcp.json`):

```json
{
  "mcpServers": {
    "flowctl": {
      "command": "node",
      "args": ["/abs/path/flowctl/packages/mcp/dist/bin.js", "--config", "/abs/path/to/flowctl.config.yaml"],
      "env": { "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}" }
    }
  }
}
```

Kiro expands `${TYPESAFE_API_KEY}` only for environment variables you approved in its settings; an
unapproved one is not filled in, and `flow_run` then answers that the key is not set. Never write the key
itself into these files. `--headed` shows the browser.

```text
flowctl-mcp [--config <path>] [--headed]
```

`--help` is read only as the first argument. Exit codes when it cannot start: `2` usage or config error, `3`
trust refusal (`trust_missing`: run `flowctl trust init`).

## Tools

| Tool | Does | Answers |
|---|---|---|
| `flow_run` | starts an exploration: `goal`, `start` (a path), `profile`, `assertions`, optional `inputs` (`{ value }` only), `maxSteps`, `envName`, `allowDestructive` (lets the agent, never System 1, click a delete- or approve-like control on a shared env; never on production) | `passed`, `failed`, `escalated`, `error`, or `running` after about 55 s |
| `flow_step` | continues one: `steps` (control ids from the escalation, or flow steps), `hint`, or `finish: true` | same |
| `flow_wait` | waits again for a `running` exploration | same |
| `flow_save` | writes a passed exploration to `<flowsDir>/<name>.yaml`, only after a model-free replay passes | `saved`, `file`, the replay |
| `flow_replay` | replays saved flows (`names`, `tag`, `envName`, `repeat` 1 to 5, `video: true` for a demo video per profile, ADR 0032), no model | counts and the runs that did not pass; `evidence.videos` with a video |

Every tool is guarded: without the trust store entry it answers `trust_missing` and touches nothing. Each
answer has a `next` field naming the call to make next. Escalation text from the page (`detail`, `controls`,
`failed.got`) is sanitised, has secrets masked, and is marked as data. At most 4 explorations are open at
once (ended ones do not count); one left idle for 10 minutes is finished. `flow_save` and `flow_replay` are
not bounded by the 55 s wait: a long replay can outlast your client's request timeout, and it still runs to
the end. Every run, exploration included, also stops at its wall-clock budget (`target.budgets.wallClockMs`, 10
minutes by default, escalation waits included) with `error: budget_exceeded`.

## Agent playbook

[`skill/SKILL.md`](skill/SKILL.md) tells an agent how to test a feature with these tools.

- Claude Code: `mkdir -p ~/.claude/skills && ln -s /abs/path/flowctl/packages/mcp/skill ~/.claude/skills/flowctl-verify`.
- Kiro: copy it into the project as a steering file that loads on request, e.g.
  `cp /abs/path/flowctl/packages/mcp/skill/SKILL.md <project>/.kiro/steering/flowctl-verify.md`; its
  frontmatter (`name`, `description`) works with `inclusion: auto`, which you add as a line in it.
