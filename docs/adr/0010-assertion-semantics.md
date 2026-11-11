---
type: ADR
id: "0010"
title: "Assertion semantics: wait with a timeout, fetch/xhr only, evidence from before navigation"
status: accepted
date: 2026-10-03
---

## Context

The spike found three bugs in a "naive" verifier:
- Instant checks made the ERP flow pass only 1/10, because lazy-loaded routes call the API late.
- The pattern `*holiday*` wrongly matched the Vite dev server's `.tsx` file requests, causing a false
  `passed`.
- Clearing logs after the page finished loading let JS errors at startup slip through.

## Decision

**Every state assertion waits until it holds, up to `assertTimeout` (default 10 seconds).
`network.absent` and `noConsoleErrors` are checked once, after all other assertions. `network`
only considers `fetch`/`xhr` requests; a URL pattern starting with `/` matches as a suffix and
allows a query string; `requestBody` is a JSON subset match. `text` is case-sensitive. Evidence
(network, console, trace) is collected from before the first navigation of each context.**

## Options considered

- **As above** (chosen): matches how Playwright's `expect` works; measured in the spike.
- **Instant check at the end of the run**: simple, but flaky with late APIs.
- **Count every request (including document/script)**: easy to mismatch, as in the Vite example.

## Consequences

- **Easier:** the seeded-bug suite catches 10/10, with 0 false reports on the clean app (phase 1);
  `requestBody` proves the right action was performed.
- **Harder:** failing flows fail slower (they wait out the timeout before the verdict).
- **Revisit when:** we need assertions on call counts (for example, preventing duplicate submits),
  or the API uses WebSocket.

## Amendment 2026-11-09: assertions anchored to the run (issue #47)

Status: accepted by the owner on 2026-11-09 together with the public v0 gate (ADR 0029); implemented in task T1.11.

The page and the requests a run sees can carry text an attacker or an ordinary user wrote (a list row, a comment,
an off-origin page that serves the expected path). So that such content cannot satisfy an assertion:

1. **`url` and `network` match only the run's origins.** A URL pattern still matches as before (a leading `/` as a
   suffix, `*` as anything), and in addition the URL's origin must be one of the run's scope (its `visit` and `call`
   origins, ADR 0024 section 3). `network.absent` ignores requests on other origins, which the scope guard blocks
   anyway. A caller that gives no origins (a library user without a run) keeps the old matching.
2. **`text` may name a region:** `{ text: "Lưu thành công", within: { role: "status" } }`. `within` is a locator
   with the same rules as a step's (testId or role and name, exactly one visible match); the text must be inside
   that element. Without `within`, the whole visible page counts, as before.
3. **An exploration never passes before it has acted.** The early check, a `DONE` and `finish` count only after an
   action other than waiting or scrolling ran, by System 1 or the orchestrator (whether the page changed is not
   required: the snapshot fingerprint does not see a click that only shows a message). A `DONE` before that is
   rejected like a failing one; `finish` before that ends `error: flow_invalid`. Such a run could not be saved
   anyway: a flow needs a step.

*Not done:* a `text` assertion does not require the text to be absent before the run acted; write `within` (a
toast, a dialog, a status region) where page content could already hold the text.
