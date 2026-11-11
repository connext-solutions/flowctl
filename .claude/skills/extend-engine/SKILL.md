---
name: extend-engine
description: Use when adding or changing a flowctl capability - a step kind, assertion kind, System 1 operation, config key, CLI command, MCP tool, or a public export of core. Gives the files to touch in TDD order and the checks that must pass.
---

# Extend the flowctl engine

Read `packages/core/AGENTS.md` (layout, gotchas) before starting. Every recipe is test first.

## Always

1. Write the failing test through the module's interface (unit if no browser is needed, else `*.browser.test.ts` on fixture-app). Run it, see it fail for the right reason.
2. Implement the smallest change. Keep folders' layer order (`flow ← browser ← run ← system1 ← explore`).
3. `bun run check` after each edit; `bun run verify` before saying done.
4. Decide whether it needs an ADR (`write-adr` skill): yes if it changes an invariant, the flow YAML format, the System 1 protocol, a result shape, an exit code or a default users rely on.
5. Update docs where users or agents look: root README quickstart (user-facing), `packages/<pkg>/AGENTS.md` table or gotchas, `CONTEXT.md` for a new domain term.

## Recipes

| Change | Steps |
|---|---|
| **Step kind** | `flow/schema.ts` (zod) → `flow/steps.ts` (normalise + `serializeStep`) → `browser/executor.ts` → browser test on fixture-app (add the control to `/lab` if missing) → recorder if exploration can produce it |
| **Assertion kind** | `flow/schema.ts` → `run/verifier.ts` → **`seeded-bug` skill** (a bug only this assertion catches) → unit test for parsing, accuracy test for catching. Remember assertions poll until `assertTimeout` |
| **System 1 operation** | `system1/protocol.ts` (`OPS`) + `system1/prompts.ts` (`OP_TEXT`) → `explore/request.ts` → `explore/act.ts` → `policy.test.ts` case → fake System 1 (`fixture-app/src/system1.ts`) → golden test diff reviewed → contract tier run (billed; ask first) |
| **Config key** | `config.ts` zod schema with a default, written like the existing sections → `config.test.ts` (default + override) → README quickstart if users set it |
| **CLI command** | Logic in core first (with its test) → `cli/src/index.ts` (parse, call, format) → `cli/test/cli.browser.test.ts` → `cli/README.md` usage + exit codes |
| **MCP tool** (phase 2b) | Core behaviour first → `mcp/src/server.ts` `registerTool` with a zod shape → test through `InMemoryTransport.createLinkedPair()` → keep results compact; nothing on stdout but the protocol |
| **Public export** | Add to `core/src/index.ts` → update the list in `core/test/api.test.ts` on purpose → mention it in `core/README.md` |

## Done means

`bun run verify` green, the new behaviour has a test that failed before, docs updated, ADR written if step 4 said so.
