---
type: ADR
id: "0030"
title: "Evidence is safe to share by default; a full trace is an explicit opt-in"
status: proposed
date: 2026-11-10
---

## Context

A run's evidence (`<flowsDir>/.runs/<runId>/`) is meant to be attached to a bug: the security rules say secret
inputs show as `***` and no cookie or storage state is written there. Three things broke that (issues #10, #11,
#18):

- The Playwright trace was started with `{ screenshots: true, snapshots: true }`. A probe on Playwright 1.63 found
  the session cookie and every `Set-Cookie` in `trace.network`, and request and response bodies in `resources/`,
  but only when DOM snapshots are on. With `snapshots: false` neither appears.
- The value of every `fill` is a parameter of the action, so it is in `trace.trace` whatever the options. Text
  typed through CDP `Input.insertText`, or set by `evaluate` with the value as an argument, is not recorded when
  DOM snapshots are off. Reading the field back with `inputValue` records its value as the call's result.
- `network.json`, the summary list and an assertion's `got` held request and response bodies as they were sent.
  `got` was masked for secret input values, but a password or token the app sent on its own was not.

## Decision

1. **Default trace: actions without DOM.** Tracing starts with `{ screenshots: false, snapshots: false }`. The
   trace keeps the action list (with each action's locator and, for a non-secret `fill`, its value), timings, URLs,
   console text and the request list, without headers, bodies, cookies or DOM. The verifier reads page text and field
   values with `evaluate`, whose result the trace does not keep (`innerText` and `inputValue` results it does).
   `run.json` records `evidence.trace: "safe"`.
2. **Full trace on request.** `flowctl replay --trace full` (and the `trace: 'full'` run option) records DOM
   snapshots and screenshots as before. `run.json` then records `evidence.trace: "full"` and the CLI prints that
   the trace holds cookies and bodies and must not be shared. It is a per-invocation choice of the person running,
   never a repo setting.
3. **Secret inputs are typed without leaving their value.** A `fill` whose value is a secret input (an `env:`
   input) focuses the field, clears it with key presses, and types through CDP `Input.insertText`. The field is
   checked with a boolean ("not empty"), never by reading its value. A secret is never typed key by key, and a
   `select` of a secret is refused (`flow_invalid`): an option label is page text.
4. **Bodies and messages are redacted before they are written or returned.** In `network.json`, the summary list,
   `console.json`, an assertion's `got`, an error hint (hook output included) and the escalation's page text: every
   secret input value becomes `***`, and so does the string or number value of a field whose name says it is a
   credential. Names ending in `password`, `passphrase`, `secret`, `token`, `otp`, `apiKey`, `authorization`,
   `cookie`, `credential`, `sessionId` or `sessionToken`, or equal to `pin`, `pinCode`, `otpCode`, `pwd`, `sid` or
   `session`, in any case and with `_`/`-`, in JSON (escaped JSON and a value cut by clipping included), form bodies
   and `name=value` / `Name: value` text; a `Cookie` or `Set-Cookie` header is masked whole. A response body is
   redacted before it is clipped. Matching (`requestBody` assertions) still uses the bodies as sent, in memory only.
5. **`final.png` masks text fields**, using Playwright's screenshot `mask`: password inputs always, and every input,
   text area and content-editable element when the run has a secret input.

## Options considered

- **Post-process the trace zip** (drop network, mask action parameters): keeps DOM snapshots, but needs a zip
  reader and writer (a new dependency or hand-written code) and must track Playwright's internal trace format.
  Rejected for now.
- **No trace by default:** safest, but loses the action timeline that `debug-run` reads first. Rejected.
- **Actions-only trace by default, full on request** (chosen).

## Consequences

- **Easier:** a run directory can be zipped and attached to a bug; the agent never sees a password in `got`.
- **Harder:** the default trace has no DOM snapshot or screenshot to step through; a person debugging a layout
  issue reruns with `--trace full`. `final.png` still shows the page at the end.
- **Not covered (a safe trace still holds):** the value of a non-secret `fill`; locators, whose accessible names are
  page text; console text as the app logged it (`console.json` is redacted, the trace is not); URLs, with any token
  in their query; during exploration, the recorder's aria snapshot of the chosen control, which includes its current
  value, so a control that already holds a secret leaks it there. **Elsewhere:** a secret the app renders as text
  outside a field (in `final.png`, and with `--trace full` in the trace); a credential under a name not in the list;
  decisions sent to System 1 (issue #13, task T5.1).
- **Revisit when:** Playwright offers a trace option without network or with redaction, or a zip post-processor
  becomes cheap to own.

## Amendment 2026-11-12: what a safe trace records of evaluations

Decided under the owner's delegation of 2026-11-11.

Decision 1 said the trace does not keep an `evaluate` result. On Playwright 1.63 that holds only for the call that
is not the first protocol call of its API call. The trace records the parameters and the result of every
non-internal call made on the context, and inside one API call only the first protocol call is non-internal.
`page.evaluate` and `frame.evaluate` are that first call, so their argument and result (page text, field values)
are recorded. `locator.evaluate` first sends `Frame.waitForSelector`, whose log keeps a preview of the resolved
element with its text; its evaluation is internal. `locator.evaluateAll` is a single recorded call, so its
argument and result are both recorded. Calls on a CDP session are not attributed to the context and are not
recorded.

So: the verifier's `text` assertion compares in the page with `evaluateAll`, passing the assertion text and
returning only whether it matched and the text length. The exploration snapshot and the ledger's page-text scan run
through CDP `Runtime.evaluate`. The `value` assertion reads with `locator.evaluate`, whose preview is the element's
attributes and not its current value. Decision 1's sentence about `evaluate` and the Context's sentence
"set by `evaluate` with the value as an argument, is not recorded" are read with this amendment. The redaction
suite (`packages/core/test/redaction/`) checks these properties on every Playwright upgrade.
