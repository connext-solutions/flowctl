---
type: ADR
id: "0006"
title: "No LLM text generation; input values come from the orchestrator"
status: accepted
date: 2026-09-29
---

## Context

jev-ultrafast uses a small LLM (via OpenRouter) to generate text when System 1 picks `TYPE_TEXT`.
That adds a provider, adds latency, and can send credentials outside. Tests need deterministic
data, not data the model makes up.

## Decision

**No LLM text generation. Values come from the flow's `inputs` (fixed values, templates
`{{uid}}`/`{{today±N}}`, or `{ env: X }`). When System 1 picks `TYPE_TEXT`/`SELECT`, choosing the
value is one more question with predefined answers: pick 1 key of `inputs`. For secrets, only the
key name is sent, never the value.**

## Options considered

- **Values from `inputs`** (chosen): deterministic, replayable, no secret leaks.
- **A small LLM generates text like jev-ultrafast**: fills forms without declaring values up front,
  but is not deterministic and adds a provider.

## Consequences

- **Easier:** every replay uses the same data; `{{uid}}` avoids duplicate-name errors on reruns.
- **Harder:** the orchestrator must declare every input value up front. Spike: mapping values by
  label is very error-prone (the ERP field is named "Số điện thoại", not "Tên đăng nhập"), so the
  value must be picked with a key question, not guessed from the label.
- **Revisit when:** we need to generate valid random data in bulk (form fuzzing).
