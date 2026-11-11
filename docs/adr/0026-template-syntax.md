---
type: ADR
id: "0026"
title: "Template syntax is a closed grammar; errors are strict and found at load"
status: accepted
date: 2026-10-29
---

> Owner acceptance: recorded 2026-10-30, including `{{lbrace}}` as the escape and the rule that env values are never re-scanned. The status is `accepted` because pull request #70 implements this decision.

## Context

Flows carry `{{...}}` templates in start pages, inputs, steps, locator names and assertions. The first
parser used two forgiving regexes: anything that did not match exactly (`{{today+}}`, `{{UID}}`, a lone
`{{`) stayed in the text, so a typo became a wrong URL, a wrong locator or a wrong assertion with no
error. The recorder also wrote page text such as "Tổng {{total}}" into a locator name, and replay then
tried to expand it. Steps given by the orchestrator during an exploration were never expanded, and a
uid copied from the page was never turned back into `{{uid}}`, so the confirming replay of a save failed.

## Decision

**Templates are a closed grammar. Anything else inside `{{...}}` is a `FlowError` that names the field,
the character offset and the allowed forms. A flow is checked when it is loaded, not only when it runs.**

- Allowed: `{{uid}}`, `{{today}}`, `{{today+N}}`, `{{today-N}}` (each with optional `:FORMAT`),
  `{{env.NAME}}`, and `{{lbrace}}` for a literal `{{`. Spaces inside the braces are ignored.
- `loadFlow` dry-runs the expansion over `start`, input values, steps and assertions: exactly the
  fields `prepareRun` expands. `setup` and `teardown` are shell text: they are never expanded or checked,
  and `{{...}}` in them (for example `docker inspect -f '{{.State.Running}}'`) reaches the shell as written.
  An unknown `{{env.NAME}}` is not an error at load: it depends on the env chosen at run time. `prepareRun`
  keeps checking at run start.
- Expansion is one pass. A value inserted from `{{env.NAME}}` is never scanned again, so an env var can
  contain `{{`. This changes behaviour: an env var whose value held `{{uid}}` used to expand.
- Adjacency: in a run of `{`, the last two open the template and the rest are literal, so `{{{uid}}}` is
  `{`, the uid, `}`. This makes any text next to a template round-trip.
- The recorder escapes page text it writes into a flow: each `{{` becomes `{{lbrace}}`, and the run's uid
  value becomes `{{uid}}`. The same uid rule applies to the steps the orchestrator gives (`untemplateUid`),
  which leaves templates the orchestrator wrote as they are.
- A malformed template in an orchestrator step during an exploration escalates `action_failed` with the
  message, so the orchestrator can send the step again. It does not end the run.

## Options considered

- **Closed grammar, escape on record, check at load** (chosen): the YAML says exactly what runs
  ([0007](0007-yaml-source-of-truth.md)); one rule for every string; errors appear where the flow is written.
- **Skip expansion for recorded names** (e.g. a `literal: true` marker on locators): needs a new field in
  the schema and every walker must know it; a name that mixes `{{uid}}` and literal braces still needs an
  escape.
- **Leave unknown `{{...}}` as text**: keeps old flows loading, but a typo in a template stays silent. This
  was the bug.
- **Backslash escape (`\{{`)**: ambiguous with a literal backslash before braces in page text.
  `{{lbrace}}` has no such case because only the opening pair is escaped.

## Consequences

- **Easier:** a typo fails fast with a position; recorded names and orchestrator steps replay as they ran.
- **Harder:** an already-saved flow with a raw `{{...}}` that used to stay literal now fails to load
  (`flow_invalid`). Write `{{lbrace}}` for a literal `{{` (README, "Flow format").
- **One bad file does not block `replay`.** `findFlowsWithErrors` loads every file and returns the
  valid flows plus a `{file, message}` per invalid one, each message naming the file. `findFlows` keeps
  throwing on the first invalid file, and `flowctl trust <name>` still uses it, so `trust` fails while any
  unrelated file in the folder is invalid. `flowctl replay` runs every valid flow and reports each invalid file as a
  `flow_invalid` error result (in the summary and the `--json` results, named after the file), so the exit
  code is 2 and CI stays red while the other flows still run.
- **Invalid files ignore filters.** `--tag` and name filters select among valid flows only; an invalid file
  is always reported, because its tags cannot be read and a run must not look green while a file in the
  folder is broken. A requested name that matches an invalid file is not "not found".
- **Revisit when:** a template form is added (extend the grammar and the error text together).
