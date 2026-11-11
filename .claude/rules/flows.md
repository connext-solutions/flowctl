---
paths:
  - "**/flows/**/*.yaml"
  - "**/.flows/**/*.yaml"
---

# Flow authoring rules

- Write assertions before running, from the diff (dev) or the acceptance criteria (tester). Never derive pass criteria from what a run happened to show.
- A flow that writes data needs at least one state assertion: `network` with `status` (and `requestBody` when it identifies the action), or the data visible after `reload`. A toast alone is not enough.
- Negative cases assert the error message and that the write was not sent (`network` with `absent: true`).
- Use `{{uid}}` in data the flow creates so replays do not collide. Dates via `{{today±N:FORMAT}}`.
- Any other `{{…}}` is an error (`flow_invalid`, with field and character). Write `{{lbrace}}` for a literal `{{`. Env values are inserted literally and never re-scanned (ADR 0026).
- Secrets only as `{ env: NAME }`; never inline. Each machine allows the name for the flow's profile once: `flowctl trust add profile <profile> <NAME> secret`.
- The file name equals `name:`.
