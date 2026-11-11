---
inclusion: fileMatch
fileMatchPattern: '{packages/core/src/system1/**,packages/core/src/explore/**,packages/fixture-app/src/system1.ts}'
---

# System 1 rules

- Secret inputs (`{ env: X }`) reach System 1 as key names only, and their values are replaced by `***`
  anywhere they appear. Other inputs send a short `preview` value so System 1 can pick the right key (ADR 0006).
  Page text goes through the snapshot, which already hides password fields.
- `decisions.jsonl` stores control labels, input keys, probabilities and outcomes. Never a typed value.
- A decision below `confidenceThreshold` escalates; never "try anyway". The threshold is a safety net,
  assertions are the real gate (ADR 0001, 0004).
- A new operation is declared by the client (`OPS`, `OP_TEXT`); the fake System 1 must be able to answer it
  before any exploration test uses it.
- Prompt text changes behaviour of a model we do not control. Change `prompts.ts` only on purpose: the golden
  test (`system1.golden.test.ts`) shows the request diff; run the contract tier before merging.
- Never call TypeSafe outside `*.contract.test.ts`. Unit and browser tests use `startFakeSystem1`.
