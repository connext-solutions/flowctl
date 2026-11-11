# Pull Request — flowctl

## Summary
<!-- What changes and why, in one to three sentences. -->

## Links
<!-- Issue (#..), ADR (docs/adr/..), previous/next PR if stacked ("Stack: 2/3, base #12") -->

## Areas touched
- [ ] `core`
- [ ] `cli`
- [ ] `mcp`
- [ ] `fixture-app`
- [ ] Skill / harness (`AGENTS.md`, `CLAUDE.md`, `.claude/`)
- [ ] CI / repo

## Testing
- [ ] `bun run verify` passes (unit + browser + accuracy)
- [ ] New behaviour has tests; a new seeded bug (if any) is caught in `accuracy`
- [ ] Real run on a target app (env, flow and result below) — only when touching explore/replay/heal
- [ ] Contract tier against real Jev (`bun run test:contract`) — only when touching the System 1 protocol or prompts

<!-- Real run: env, flow, steps, time, status -->

## Invariants (AGENTS.md)
- [ ] Verdicts come only from assertions; a System 1 `DONE` is never a verdict
- [ ] Replay calls a model only with heal on; heal never changes assertions
- [ ] System 1 runs only in `allowedEnvs`; secrets and passwords never reach a model or a log
- [ ] Browser contexts are created only through `RunSession`
- [ ] No keys, `.flows/.auth`, `.flows/.runs` or internal working docs committed

## Design decisions
- [ ] No new decision
- [ ] Yes, ADR added/updated: <!-- docs/adr/00xx-... -->

## Breaking changes
- [ ] None
- [ ] Yes (flow YAML, config, MCP/CLI results, exit codes) — migration notes:

## Notes for reviewers
