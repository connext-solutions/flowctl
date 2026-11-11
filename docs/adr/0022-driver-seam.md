---
type: ADR
id: "0022"
title: "System 1 becomes a Driver interface; Jev and a generic LLM client are adapters"
status: proposed
date: 2026-10-29
---

> Owner acceptance: recorded 2026-10-30 (tasks T0.10, T0.15). The status stays `proposed` because the lifecycle in `docs/adr/README.md` reserves `accepted` for a decision that is implemented; no code exists yet.

## Context

ADR 0003 kept one HTTP client for the TypeSafe `/v1/systemone` protocol and no interface, because there
was one adapter. The roadmap needs a second one: a generic LLM client (Anthropic and OpenAI-compatible
endpoints, including local models), so the open core does not depend on one vendor. With two adapters the
seam is real (`.claude/rules/architecture.md`).

Today the exploration loop and heal call `System1Client.decide(DecideInput): Promise<Decision>` directly
(`system1/client.ts`, types in `system1/protocol.ts`). `System1Client.fromConfig` is the one place that
enforces `system1.allowedEnvs`. The wire body is built for Jev's scored format (questions with answer
keys and probabilities), so a generic LLM adapter needs its own request and parser.

Open review findings sit in the same code and are cheaper to fix inside the new contract: https only
(#14), `res.json()` and `res.text()` outside the `RunError` wrapping (#26), the `k in a.probabilities`
prototype-chain check (#58), server text echoed into errors and saved flows (#59), unmasked page text
(#13), `allowedEnvs` not enforced on every path (#15), and a steered heal written back silently (#48).

## Decision

**System 1 is an interface called `Driver`. The exploration loop and heal depend on `Driver` only. `JevDriver`
and `LlmDriver` are adapters. A driver ranks and proposes; it never decides a verdict (ADR 0004).**

### Interface

The interface is the existing call, not a new vocabulary. In `core/src/system1/`, through its `index.ts`:

```
interface Driver {
  decide(input: DecideInput): Promise<Decision>;
  readonly id: string;
}
```

- `DecideInput = { goal, page, history, ops, inputs, secrets }` and
  `Decision = { ranked: { op, p }[], targets: Partial<Record<TargetOp, { id, p }>>, input?: { key, p }, model }`
  stay as in `protocol.ts`. `p` is a probability in `[0, 1]`. A generic LLM adapter must produce it (from
  a self-reported score, logprobs, or a fixed ladder); the loop and heal compare it with their thresholds.
- **Heal is not a Driver method.** `healStep` stays a function over `decide()`: it offers `HEAL_OPS` for the
  broken step's kind, takes the top choice only if `top.p` and `target.p` reach the threshold, and never
  touches an assertion (ADR 0008). A second adapter must not change that.
- `id` is a stable adapter name for `decisions.jsonl` and the report. `Decision.model` stays the reported
  model.

### Where `allowedEnvs` is enforced (#15)

Today `System1Client.fromConfig` enforces it, and `replayFlow` or `healStep` could receive a client built
some other way. The rule: **a `Driver` is obtainable only from a factory** that takes the run's `env` and
the effective `system1` settings (the intersection of the repo config and the trust store, ADR 0025 and
0024 section 1) and throws `RunError system1_not_allowed`. The factory returns a **branded, opaque type**
(`CheckedDriver`, constructor not exported); the loop, heal and the confirming replay accept only that
type, and a `check-arch` rule (task T5.1) fails the build on any construction of a driver class outside the
factory module. The type brand is erased at run time, so the loop, heal and the confirming replay also
check at run time that the value is a `CheckedDriver`: the factory registers each instance in a
module-private `WeakSet` (the class uses `#private` fields), and each entry point rejects an object that
is not in it or fails `instanceof`. T5.4 tests that every call path (exploration, `replay --heal`, confirming replay in
`saveExploration`) is refused outside `allowedEnvs`.

**Acceptance criterion: a pull request, or an agent with write access to the repository, cannot make a
run send page data to a host the owner did not trust.** So the data policy is keyed on the endpoint, not
only on the env label: `system1.baseUrl` must be inside the trust store's `allowedHosts`, and
`system1.apiKeyEnv` must be a name the store allows.

### Adapter contract

Shared contract tests (T5.4) run the same flows on both drivers.

1. **Redaction of the view.** One shared function in core masks the `DecideInput` view before any adapter
   sees it: known secret values become `***`, and the text, title, URL and control labels of the page are
   masked the same way (#13). Each adapter then builds its own wire body from the masked view; a shared
   function cannot build both bodies, so each adapter has a golden test of its body. Adapters cannot widen
   the view. No cookies or authorization headers are ever part of the view, so none are listed.
2. **Secrets inside `DecideInput`.** `DecideInput.secrets` carries raw secret values today so the client can
   mask them. That moves into the shared redaction function: adapters receive the masked view and an empty
   `secrets` list, so no adapter holds a raw secret. The Jev body keeps sending key names only (ADR 0006).
3. **Known-secret masking does not catch page-content secrets** (bearer tokens in URLs, JWTs, long hex
   strings, personal data shown on a page). The shared function adds a pattern pass (JWT shape, bearer,
   long hex or base64 runs, URL query values for keys such as `token`, `key`, `sig`). The pass reads at most
   64 KiB of page text per request, **and the view sent to the driver is truncated to the same 64 KiB**, so
   text beyond the cap is never sent unscanned; matching is linear-time only (no nested quantifiers), so it
   cannot be turned into a regular-expression denial of service. Anything outside the patterns is an accepted
   risk, listed in the report of the Driver benchmark, and the reason System 1 runs only in `allowedEnvs`
   (ADR 0005).
4. **#58 prototype-chain.** The adapters look up model answers with `Object.hasOwn`, never `in`, so keys such
   as `__proto__` or `constructor` in a response are not valid answers.
5. **#59 server text.** Text from the model or server is bounded and sanitised before it can reach an error
   message, `decisions.jsonl`, an escalation or a saved flow: at most 1 MiB of response body, **counted while
   streaming and after decompression** (the read stops and the call fails when the cap is passed, so a
   compression bomb is not read in full), and 200 characters per field that is echoed. Errors never contain
   the request body, the response body or the API key (the leftover of #18).
6. **Response validation.** A strict schema parses the response; `op` must be in the closed operation set
   offered in `ops`; a target `id` must exist in the current control table of the snapshot; `p` must be in
   `[0, 1]`; unknown fields are dropped. A response that fails the schema is a `RunError`
   `system1_invalid_response`, not a guess.
7. **Transport (#14).** Endpoints must be `https://`. Plain `http://` is accepted only for loopback, and
   loopback is decided on the **connected socket's remote address**, not on name resolution, so DNS
   rebinding cannot turn a name into a public host after the check. Loopback means `127.0.0.0/8`, `::1`,
   and `::ffff:127.0.0.0/104`; `0.0.0.0` is not loopback; decimal, octal and hex IP spellings are
   normalised by the URL parser first and compared as addresses. The name `localhost` alone is not enough.
   Redirects are not followed (a redirect is an error); the API key is never forwarded on a redirect. The transport ignores `HTTP_PROXY` and `HTTPS_PROXY` and refuses `NODE_TLS_REJECT_UNAUTHORIZED=0` and
   custom CAs unless the store allows them for that host. A non-conforming endpoint is a `ConfigError` at
   construction. `allowedHosts` means **exact host plus port,
   no wildcard, no suffix match**, comes from the trust store, and the destination host is written to
   `decisions.jsonl`.
8. **Failure behaviour (#26).** Per-request timeout; a bounded retry with backoff on the real
   `RETRY_STATUSES` (429, 503, 529) and on network errors; no retry on other 4xx or on 5xx outside that
   set. After the budget the adapter throws `RunError` `system1_unreachable`, so the run ends `error` with
   a hint, never `failed`. Both halves of #26 are covered: `res.json()` and `res.text()` in
   `system1/client.ts` move inside the `RunError` wrapping, and the `waitForLoadState` call in
   `browser/executor.ts` (after the step's `try`) is wrapped so a navigation race becomes a `StepError`.
9. **No text generation.** An adapter returns operations, control ids and input keys offered by the
   orchestrator (ADR 0006); a `value` that is not one of the offered inputs is rejected.
10. **The API key** is read from the environment variable named in `system1.apiKeyEnv`, which must be one
    of the names the trust store allows; it is never read from a flow, never logged, and removed from hook
    and resolver environments (ADR 0021, 0024).
11. **Secret-valued inputs** are typed only into a field of the role their kind allows (ADR 0024 section 4:
    password references into password-type fields, the env username into the username field); a driver
    proposing one for any other control is refused.
12. **Outcome.** Whatever a driver returns, the executor acts through strict locators and the verifier alone
    decides pass or fail. Swapping the driver can change which steps are explored, never an assertion.

### Steered heal (#48)

The model-reported `p` is not trustworthy evidence: page text can steer a model into a confident wrong
choice (a "Cancel" button labelled to look like "Save"). A heal can therefore be steered and then written
back into a flow without a person seeing it. The fix is not in `system1/`: `explore/` must mark a healed
locator in the run output, and `save` must refuse to write a flow containing a healed step unless the
caller confirmed the change. This stays gated by T5.8 whatever the threshold.

### Migration

T5.1 extracts `Driver` and moves the existing client behind it as `JevDriver` (the one that changes code).
T5.2 is the proof that nothing changed: golden bodies, the unit tier, the contract tier on the fixture
app, and an unchanged `decisions.jsonl` shape. T5.3 adds `LlmDriver`.

## Options considered

- **`Driver` interface over the existing `decide`** (chosen): the loop is vendor-neutral, redaction,
  validation and failure rules live once, contract tests compare drivers on the same flows.
- **One concrete client; the generic LLM speaks the Jev wire protocol through a proxy**: hides the
  translation outside the repo and its tests.
- **Per-adapter redaction**: each adapter masks for itself. Rejected; that is where leaks happen.
- **Heal as a Driver method**: lets an adapter implement its own heal rule. Rejected; the threshold rule
  is part of the safety argument of ADR 0008.
- **The model chooses pass or fail**: rejected by ADR 0004.

## Consequences

- **Easier:** a user without a Jev key can run exploration with their own model. #14, #26, #58, #59, #13
  and #15 are fixed once, in the contract, with tests that apply to every adapter.
- **Harder:** a generic LLM is slower and less reliable at choosing a control than Jev's trained head;
  escalation rates differ per driver and the benchmark reports them per driver. `p` from a generic LLM is
  weaker evidence than Jev's, so thresholds may need a per-driver value. The pattern pass for page-content
  secrets will have false negatives.
- **Supersedes in part:** ADR 0003 (no interface). It stays `accepted` until this ADR is accepted.
- **Revisit when:** a third adapter shows the interface is too narrow, or a driver needs streaming or
  multi-turn state.
