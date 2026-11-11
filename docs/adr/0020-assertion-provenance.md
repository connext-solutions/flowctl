---
type: ADR
id: "0020"
title: "Every generated assertion carries a typed sourceRef: spec, contract, invariant or baseline"
status: proposed
date: 2026-10-23
---

> Owner acceptance: the text, including the amendments of 2026-10-29 and 2026-11-01, accepted 2026-11-02 (tasks T0.10, T0.22); Amendment 2026-11-02 (task T0.32) accepted 2026-11-06 with its recommended defaults. The status stays `proposed` until implemented.

## Context

The roadmap adds a Derive step that turns business operations and an observed app map into test
cases. Generation is where the verdict rule (ADR 0004) is most likely to break: a model that writes
both the steps and the expected result can make a test pass or fail for the wrong reason.

The first draft of the roadmap allowed expected results only from spec text, with a `sourceRef`.
That works for apps with written specs (the private internal-wiki plugin) but gives almost nothing for
an app without one: every case falls back to `smoke-only`. Most apps outside the company have no
machine-readable spec, so the open core would depend on a source most users do not have.

Expected results can come from other places that are just as deterministic: rules every web app
must obey, contracts already in the code, and behaviour a person has reviewed and approved.

## Decision

**Every assertion produced by Derive carries exactly one `sourceRef`, and its kind is one of four.
A model may propose steps and may point at a source; it never supplies the expected value itself.**

| Kind | Where the expected value comes from | Checked by |
|---|---|---|
| `spec` | Verbatim text from a `SpecProvider` (markdown, Gherkin, test-case sheet, issue acceptance criteria, internal-wiki) | The quoted text must exist in the provider's source at `ref` (string match, no model) |
| `contract` | A contract in the code under test: OpenAPI or GraphQL schema, a form validator (zod, Joi, HTML `required`/`maxlength`/`pattern`), an i18n message key | The file and symbol or key must exist; the value is read from it, never paraphrased |
| `invariant` | A rule from a fixed library in core that holds for any web app (for example: created item appears in its list, deleted item is absent, reload keeps saved data, no 5xx, no console error) | The invariant id must exist in the library; each invariant has a seeded bug in fixture-app |
| `baseline` | A value observed in a run that a person approved | A case-approval record (amendment, section f) must exist, signed by a reviewer key in the trust store; `approvedBy`, `approvedAt` and `runId` are fields of that record, and the `sourceRef` of a baseline holds only the record id; only the review gate (a human action) can create one |

Rules:

1. A derived flow is refused at save (`FlowError`) if any assertion has no `sourceRef` or an
   unknown kind, or if the reference does not resolve.
2. A case whose only assertions are the free checks is labelled `smoke-only`.
3. `contract` assertions test consistency (client against server validation, message shown against
   the i18n file, response against schema). They do not prove business correctness, and the report
   says so.
4. When no spec exists, an agent may interview the user and write the answers to a markdown file
   with an author line. That file is then an ordinary `spec` source; the model only transcribes.
5. The verdict rule does not change: `sourceRef` explains where an expectation came from and sets
   its weight in the report; pass or fail is still decided only by the verifier.
6. *Superseded by the amendment, section b.* Hand-written flows (from a diff or acceptance criteria, ADR
   0004) may omit `sourceRef` only when the trust store lists the file as `hand-written`; otherwise the
   file is `unclassified` and `flowctl check` fails. Existing hand-written flows are classified once by the
   migration task T4.16.

## Options considered

- **Four typed kinds** (chosen): works on apps with no spec (invariant, contract, baseline), keeps
  internal-wiki as one `spec` adapter among several, and every kind is checkable without a model.
- **Spec text only** (first roadmap draft): strongest guarantee, but apps without a spec get only
  smoke checks, and the open core leans on a private source.
- **Model infers the expected result from the page or the code**: covers everything, but it is the
  model judgement ADR 0004 rejects.
- **Baseline only (snapshot testing)**: cheap, but locks in existing bugs and says nothing about
  what the app should do.

## Consequences

- **Easier:** Derive is useful on any app on day one (invariants and free checks), better with a
  contract, best with a spec. The roadmap can prove independence from internal-wiki by running P3 and
  P4 on fixture-app with markdown specs and invariants only.
- **Harder:** the invariant library is code to maintain, and every invariant needs a seeded bug.
  Baselines cost reviewer time and can approve a bug if the reviewer is careless. Contract
  assertions can be tautological if used to claim business correctness.
- **Revisit when:** a source kind is needed that none of the four covers, or measurements show
  `baseline` approvals letting bugs through.


## Amendment 2026-10-29: spike findings and trust model

A read-only spike (task T0.7) joined a crawl of fixture-app with a markdown spec and looked for assertions
that carry a `sourceRef` and no invented expectation. It found gaps in the rules above. A review then found
that several checks compared a value against data the actor under suspicion can edit (a pull request) or
against a process that runs in the same place as the generator.

**Acceptance criterion for this ADR: a pull request, or a script supplied by the repository, cannot forge a
provenance claim, a resolution or an approval, assuming the agent cannot execute arbitrary commands as the
owner outside the harness (ADR 0025 section 6 states what holds against a same-user agent with a shell).**
The trust values live in the per-machine store of ADR 0025. Direction approved by the owner on 2026-10-30 (task T0.10); this is not acceptance. The status is `proposed` and stays so until the decision is implemented (`docs/adr/README.md` reserves `accepted` for that); no code exists yet.

### a. `sourceRef`: per expected item, with a record of who wrote the source

`sourceRef` is an optional field of the assertion schema: `{ kind, ref, quote?, quoteSha256?, contextSha256?,
revision?, author?, review? }` with `kind` one of `spec | contract | invariant | baseline`. It is **per expected item**:
ADR 0023 gives `Operation` an explicit `expected[]` and each item has its own `ref`; the assertion points at
one item (or one contract symbol, invariant id, baseline id).

For `kind: spec`, **`quote`, `quoteSha256`, `contextSha256` and `revision` are required**; a spec `sourceRef`
missing any of them is refused at load.

Spec authorship is recorded: `author` (`human`, `agent` or a named person) and `review` (`reviewed` or
`unreviewed`). **These and the spec language come from the trust store or from signed metadata, not from the
spec file**, which the generator or a pull request could edit. A spec written by an agent (the interview
skill, T4.11) is counted separately in reports and benchmarks, like baselines.

### b. Provenance is bound to the entry point, and classification to the store

`origin` is **not an argument** of `save`. The derive pipeline calls an internal-only function,
`saveAsGenerator`, which records `generator`; the public CLI and MCP save paths always record `human`.
`saveAsGenerator` is **not exported** from `packages/core/src/index.ts` and not reachable through the
package `exports` map, `derive/index.ts` does not list it, and it is obtained only through a module-private
capability created inside derive (a non-forgeable token passed as an argument). A `check-arch` rule fails
the build if its name appears in any tracked source file outside `core/src/derive/`, `core/src/save.ts` and
`core/test/derive/`, or in `derive/index.ts`; that text search (normalised for concatenation and escapes)
is a **tripwire only**, and the real control is the missing export plus the capability. A generator flow must have a resolving `sourceRef` on every assertion. The flow marker
`derived: true` is for readers; it is not what turns the rule on.

Classification is bound to the store. A flow file is `generator` when it has a valid signed case-approval
record (section f) naming its content hash; generator commits are identified by that record, **not by the
commit author field**. A file is `hand-written` only when its path and **closure digest** (the flow plus the
files its hooks call, [ADR 0021](0021-hook-consent.md) amendment section 2) are in the store's `handWritten`
section (set by the owner with `flowctl trust add handwritten`; CODEOWNERS is not an anchor here, see ADR 0025).
A flow with an `uncovered` hook cannot be classed. A flow that carries `derived`, a `sourceRef` or a record
and fails verification is `unverified` (section h); anything else without a store entry is `unclassified`.
**`flowctl check` fails on `unverified` and on `unclassified`**, and so does CI.

### c. Invariants are templates whose parameters come from evidence

The library fixes the whole assertion shape. Template parameters are enums defined by the template or
`valueFrom: <stepInput>`. The generator does not choose `status class` or `absent` freely: they are **bound to
AppMap evidence**, such as an observed probe (the 4xx a probe received, the request a click actually
sent), and a parameter without matching evidence is refused. A free check (no 5xx, no console error) is the
invariant template `no-5xx` or `no-console-error` with `sourceRef: { kind: invariant }`; a case with only
free checks is still `smoke-only`.

### d. Resolution is by equality of a whole item, and it fails closed

Existence of a quote is not enough, and neither is a substring (`5` is inside `15 items`, `OK` inside
`BOOK`, `deleted` inside `is not deleted`, a truncated quote hides the sentence's meaning).

- **Normalisation:** Unicode NFC, then collapse runs of ASCII whitespace and trim. The following are
  **refused** in the quote and in the expected value: Default_Ignorable_Code_Point, categories `Cc` (other
  than the normalised whitespace), `Cf`, `Zl`, `Zp`, `Co` and `Cn`. A text whose NFKC form differs from its
  NFC form is refused, and non-ASCII decimal digits (`Nd`) are refused, so homoglyph and compatibility
  tricks do not pass. "Letter" and "digit" are Unicode properties.
- **`spec`:** the quote must be the **whole expected item** (the full sentence or list entry the provider
  returns as `expected[i].text`), and the assertion value must equal the item's declared `value`. Equality
  is mandatory; there is no substring search. The declared `value` must occur **exactly once** in `text`, at
  token boundaries. The item's context (its heading and lead-in) is carried with it and is part of what the
  reviewer sees. The quote is capped (default 500 characters).
- **Polarity is declared and signed, not detected.** A negation word list cannot be complete and is a
  pattern list. Instead each expected item carries a structured `polarity` field (`positive` means "this
  text states what must be true"). A generator cannot set it; the reviewer sets it when signing the case
  approval (section f). An item without a signed `positive` polarity is refused (fail closed). A negation
  word list, if kept, is only a warning in the review screen. Language is the store's per-project default
  and the item must match it; a mismatch is refused.
- **Numbers** are bound to a field or label of the same item, compared as parsed numbers **with their
  unit**, in a fixed locale stated by the store (default `en`); an item with two numbers and no binding is
  refused; a number from the wrong field fails.
- **`contract`:** static parsing only (an AST or schema read, never `import`, `require` or evaluating
  the file). A tracked file is **not** a trust anchor; contract roots come from the trust store
  (`roots`), and the file is opened with `realpath` containment, `O_NOFOLLOW` and `fstat` (regular file,
  link count 1, so a hard link out of the root is refused), and the opened descriptor's device and inode
  are compared with the path so a directory swapped between check and open is detected.
- **`invariant`:** the assertion must equal what the template expands to.
- **`baseline`:** see f.

### e. Freshness: `check` re-runs the full comparison

Resolution happens at save, and the resolved bytes are stored (`quoteSha256`, `contextSha256`, provider
`revision`). **`flowctl check` re-runs the entire comparison** against the current source (not just the hash and
the revision); any difference is `stale_sourceRef`, which fails `check` in CI and never changes a verdict.
**Load and replay do only the cheap checks of section h** (content hash, signature, key, revision) and say
"freshness not checked at run time"; they do not open the sources.

### f. Approval records: every case is signed, a baseline is one kind

Every case that Derive produces, whatever its source kind (`spec`, `contract`, `invariant`, `baseline`), is
approved by a person who signs a **case-approval record** with an Ed25519 key. The key is the reviewer's, lives
outside the repository and outside the generator process (mode 0400, passphrase-protected or
hardware-backed, never in an environment variable). Verifiers hold only public keys from the trust store
(`reviewerKeys`: person, scope, expiry, revocation list). There is no shared secret and **no HMAC**.

- The signed payload, in a length-prefixed canonical encoding, covers: the **canonical hash of the whole flow
  content**, each assertion with its `sourceRef`, the polarity of each spec item, the hashes of the replay
  runs that confirmed the case, the hash of the AppMap evidence, the reviewer key id, `approvedAt`, the `project` and `flowName` (Amendment 2026-11-02 section j), and a
  **flow revision number** (monotonic per flow; its source, bump rule and the effect of a rename or copy are
  fixed by Amendment 2026-11-02, section j). For a `baseline` it also covers the approved value and the
  evidence summary the reviewer saw. Changing any byte of the flow, moving the record to another flow or an
  older revision, or using a revoked or expired key, invalidates it.
- Replay and rollback protection (the full rule, with its limit, is section i.1): a record whose revision is
  below `max(flowFloors, latestRevision)` for (project, flow name) is rejected (superseded, Amendment
  2026-11-02 section l: a third, optional term joins the maximum). `latestRevision` is written
  **only by the interactive approval command** (`flowctl review`, Amendment 2026-11-02, section k), never by a replay or `check`; `flowFloors` is set by the
  owner-signed `flowctl trust add floor <flow> <n>`. The rule holds only where the store has such a value
  (section i.1).
- The evidence summary (network lines and snapshot text) and its source-run hashes are **stored with the
  flow** (`<flow>.approvals.json`), not only under the ephemeral `.runs/`.
- Approval is a CLI action on an interactive terminal (nonce on `/dev/tty`, refused without a TTY), and is
  never exposed over MCP. **The approval command re-does the work itself, in its own process**: it
  re-resolves every `sourceRef` against the sources and re-runs the confirming replays; it does not trust
  hashes or evidence summaries supplied by the generator. The assertion operators it allows are
  **derived from the signed polarity**, and the review screen shows exactly what the verifier will
  check. A same-user process with its own pseudo-terminal can defeat a TTY check; that is out of scope of
  any local mechanism (ADR 0025 section 6), so the enforced control is the signature with a key the
  generator does not hold.
- **Rollback.** The latest revision per flow is kept in the trust store (`latestRevision`); this holds per
  machine and only where the store has a revision for the flow (section i.1). A store shared between machines
  or a fresh CI runner is a stated limit: an old record signed with a still-valid key can be replayed where no
  newer revision or floor is recorded (superseded by Amendment 2026-11-02 section l, which adds the merge-base
  term and names the limit).
- Generator output that already contains a `baseline` reference or an approval record is rejected. Reports
  count baselines separately.

### g. `absent` must not be vacuous

`network ... absent: true` passes trivially if the request could never be sent. For every derived `absent`:

- the request is matched by method plus URL pattern, and the action step is a `click`, `press` or `submit`
  on a control within the form or region whose submit URL matches, per the AppMap, or a navigation to the
  pattern;
- the request is of a class that `network` assertions observe (**fetch and XHR only**, ADR 0010); a native
  form post or a document navigation is not observable, so an `absent` on it is refused;
- the action step is unconditional, runs **before** the assertion, is **not preceded by a failing step**,
  and acts on a control that is **visible and enabled**;
- the assertion is evaluated **only after the request window has settled** (the action's network idle plus
  the assertion timeout), never before.

If any condition fails the assertion is refused as vacuous.

### Relation to ADR 0004

ADR 0004 says the verdict comes only from deterministic assertions. This amendment **narrows** it in one
place: a `baseline` is an observed value that a human approved, and a verdict from it is deterministic
only relative to that approval. The verdict rule is otherwise unchanged (a model never supplies an
expected value, and pass or fail is decided only by the verifier). ADR 0004 gets a pointer to this section
and the index notes it.

### Consequences of the amendment

- **Harder:** the comparison, vacuity, signing and trust-store work lands in T4.3, T4.5 and the trust-store
  task; the flow schema change (T0.11) needs the owner's acceptance first; reviewers need a key.
- **Easier:** "0 literals not derivable from their source" becomes a script with a negative test
  (`docs/benchmarks/targets.md`).

## Amendment 2026-11-01: provenance at every entry point, and three stated limits

Accepted by the owner on 2026-11-02, as written and including the recommended default of each decision it marks; task T0.22 is closed and T0.11 may start once its other
dependencies are met. Security review of PR #73 and the three independent reviews that followed it. Sections b, e and f put the
checks in `flowctl check`, which a person or CI may never run before a flow is replayed and reported. This
amendment moves the cheap part of the check to every entry point and states three limits the earlier text left
open. The status stays `proposed`.

### h. Provenance state is computed on every replay, and the label never changes a verdict

One function, `provenanceState(flow, store)`, returns one of four states. **T0.11 ships it as a stub in
`core/src/provenance/`** (T4.5 replaces the body with real verification). Until then it **never returns
`verified`**. **Where it is called:** from `replay.ts` and from the CLI and MCP handlers, which sit above
`provenance/`; **never from `flow/` or from `run/`**. `CORE_LAYERS` in `scripts/check-arch.mjs` puts
`provenance` above `run`, so `run/` cannot import it. `run/` instead receives the result as an **injected
option** (`provenance: { state, notes }`) and writes both to `run.json`. The enum `ProvenanceStateName`
(`verified | hand-written | unverified | unclassified`) lives in `foundation/`, the lowest layer, so `run/` and
the CLI can name it without importing `provenance/`. **Ordering:** T0.11 adds only the option, the enum and the
stub, and lands before T1.2, T1.3 and T5.1 (they own `run/session.ts`, the exploration run and the System 1
path); those tasks rebase onto it and add no second route to `run.json`. T0.11 does not ship without the stub.

| State | When |
|---|---|
| `verified` | A signed case-approval record names the flow's content hash, its key is in the store, in scope, not expired or revoked, and its revision is not below `max(flowFloors, latestRevision)` (section f, i.1; with the optional merge-base value as a third term, Amendment 2026-11-02 section l) |
| `hand-written` | The flow carries **no** `derived` marker, no `sourceRef` and no record, and the store's `handWritten` section lists its path and **closure digest** (section b) |
| `unverified` | The flow carries `derived`, a `sourceRef` or a record, and `verified` does not hold (a check fails, or no verifier is installed) |
| `unclassified` | Neither a claim nor a store entry |

**Precedence, evaluated in this order:** `verified`, then `hand-written`, then `unverified`, then
`unclassified`. A flow that carries `derived` or a `sourceRef` is **never** `hand-written`, even if the store
lists its path: the listing is ignored for it and the flow is `unverified`.

`replay` and `run` obtain the state for every flow they execute. It does the **cheap** checks only (content
hash, signature, key scope, expiry, revocation, revision); re-resolving each `sourceRef` against its source stays
in `check` (section e). The result carries two required fields, **`provenance`** (the enum) and
**`provenanceNotes: string[]`** (required, may be empty; the values are `rollback_not_checked`, section i.1 (its rule is superseded by Amendment 2026-11-02 section l), and
`freshness_not_checked`, which is always present at run time, plus the reason codes that Amendment 2026-11-02
defines: `record_flow_mismatch`, `flow_name_mismatch`, `revision_below_floor`, `merge_base_unresolvable`,
`merge_base_record_invalid`, `spec_sig_conflict`, `signature_unavailable`; the full list is in Amendment 2026-11-02 section p). A flow in state `unverified` or `unclassified` is
labelled **`unverified provenance`** in the summary, in `run.json` and in the report, which never prints a
`sourceRef` quote as fact for such a flow, counts it separately like baselines, and keeps it out of any "derived
from spec" total. **Until the MCP package exists (T7.2), the CLI JSON output and `run.json` carry both fields;
T7.2 adds them as required fields of the replay and run tool result schemas, with a schema test that fails if a
result is built without them**, so no consumer relies on "missing means unverified".

- **The label never changes the verdict** (ADR 0004, and section e for `stale_sourceRef`). The replay still
  runs model-free and passes or fails on its assertions.
- **Exit rules.** `flowctl check` fails on **both** `unverified` and `unclassified`, unconditionally, in every
  store. Replay and run (the CLI, and the MCP run tool when it exists) exit non-zero as follows: in a store
  marked `ci`, a run that executed an `unverified` flow exits with reason `provenance_unverified`, so a pass is
  not allowed to look like a verified pass; a run that executed an `unclassified` flow exits with reason
  `provenance_unclassified` **only once the store carries `classification: enforce`**, which the owner sets with
  the signed `flowctl trust ci --enforce-classification` (T4.16 prints that command at the end of its batch).
  Before then `unclassified` is labelled only, so existing CI runs do not break before the migration.
  **`replay --require-provenance`** applies the same rule outside a `ci` store (unverified fails; unclassified
  fails if the store carries `classification: enforce`). It can only tighten: the flag never turns a failing
  rule off, and the `ci` marker sets it. **Owner decision:** default to enforce after T4.16 (recommended), or
  label only.
- Production read-only replay refuses a flow in either state (ADR 0024 section 2a).

**What enforces classification between T0.11 and T4.14.** `flowctl check` (T4.14) is the gate above; before it
ships, the state function that T0.11 wires into `replay.ts` and the CLI handlers labels every flow, so the
label holds as soon as T0.11 ships.

### i. Limits

1. **Rollback to an older signed revision passes where the store has no revision.** Section f keeps
   `latestRevision` per (project, flow name) in the store, written only by the interactive approval command. A
   CI store is provisioned before the job and read-only to it (ADR 0025 section 3), and a fresh runner has no
   record of any flow's latest revision. A pull request can restore an older flow file together with its older,
   still validly signed record, and it verifies. Mitigation: `flowFloors`, keyed by (project, flow name), set by
   whoever provisions the store with the owner-signed `flowctl trust add floor <flow> <n>`. `verified`
   requires revision `>= max(flowFloors, latestRevision)`; **when the store has neither value, the state is
   `verified` and `provenanceNotes` holds `rollback_not_checked`** (superseded by Amendment 2026-11-02,
   section l: the required revision is a maximum over three sources, the third being the optional merge-base
   rule, and the note is present only when all three are absent). Key expiry bounds the window further.
   *Alternatives considered:* a per-flow revision file in the repository (the pull request rewrites it too); a
   remote revision service (a new dependency, not now). **Owner decisions:** (a) with no floor, CI only labels
   (recommended, since provisioning floors does not exist yet) or CI fails; (b) in CI, additionally require the
   record's revision to be at least the revision recorded for the flow at the pull request's merge base (a git
   object the PR cannot rewrite; exact rule: Amendment 2026-11-02, section l). Recommended: adopt (b) when
   T4.5 lands.
2. **Who signs spec metadata, and over what.** Section a takes `author` and `review` "from the trust store or
   signed metadata" but never said which key signs. Defined: a detached Ed25519 signature made by a
   `reviewerKeys` entry with scope `spec` (a key the generator and the interview skill do not hold). The `.sig`
   file is `<spec path>.sig`, a JSON map from `operationId` to `{ signature, keyId }` (one entry per signed
   operation), for a file source; for a source that is not a file on the machine (internal-wiki) the provider
   returns the same map through its `signatureRef` (the file shape, with several keys per operation, is
   superseded by Amendment 2026-11-02, section n; the `signatureRef` contract is in ADR 0023's amendment of
   the same date). **The signed unit is one operation** (its exact key set and bytes are superseded by
   Amendment 2026-11-02, sections m and n; the text below is the summary): canonical JSON of
   `(provider, ref, id, title, actor, expected[])` where `provider` and `ref` are the operation's `location`
   (so a signature cannot be moved to another document) and each expected item carries `text`, `value` and
   `context` (i.3), together with `author`, `review`, `language` and `metaRevision`. `metaRevision` is an
   **integer chosen by the signer** and bumped on each re-signing; it is not the provider's revision (a git
   commit or file hash, which has no order). The store may carry `specFloors[provider/ref]`, a minimum
   `metaRevision`; a signature below the floor reads as unsigned. **One language outcome:** if the signed
   `language` differs from the store's per-project `language` (ADR 0025 section 2, `projects`), the metadata
   reads as unsigned, and an unsigned item then fails the equality check of section d (spec items are
   refused, fail closed). Metadata whose
   signature is missing or invalid reads as `author: unknown, review: unreviewed` and is counted as
   agent-written. **An unsigned human-written spec therefore also counts as unknown author; this is intended**:
   a spec nobody attested to is not trusted because it looks human. Limits that remain: the signature proves who
   attested, not that they read the spec carefully; an edit to the operation invalidates it; a stolen reviewer
   key signs anything until revoked. *Alternative considered:* store-held authorship by path and hash (as
   `handWritten`); it does not fit sources that are not files on the machine.
3. **A spec item's heading and operation are outside the equality check.** Section d compares the item's `text`
   and `value`, yet says its heading and lead-in are "part of what the reviewer sees". The failure mode: a pull
   request renames `## Create order` to `## Delete order`, and the same sentence "The order appears in the list"
   is now attached to another operation and still resolves. Mitigation: the provider returns each expected
   item's `context`, defined as `{ operationId, operationTitle, headings, leadIn }` where `headings` is the list
   of ancestor heading texts, outermost first, each NFC-normalised, and `leadIn` is the NFC-normalised lead-in
   text or `null`. `contextSha256` (field of `sourceRef`, section a) is the sha256 of the canonical JSON of that
   object (byte-level profile and a worked example: Amendment 2026-11-02, section m). The signed payload of section f covers it, and the re-run of section e compares it; a change is
   `stale_sourceRef` with reason `context_changed`. ADR 0023's `expected` item gains the `context` field.
   *Testable case:* resolve and sign an item, then rename an ancestor heading, or the operation title, in the
   spec: `check` reports `stale_sourceRef` with reason `context_changed`, and the verdict of a replay is
   unchanged. Remaining limit: before signing, only the reviewer's reading of the context protects against a
   heading that already misdescribes the item.

## Amendment 2026-11-02: revision, signing commands, floors, canonical JSON and classification export

Accepted by the owner on 2026-11-06, as written and including the recommended default of each decision it marks. Closes task T0.32.

Sections f, h and i name values and files (the approval **revision**, `metaRevision`, `.sig`, `context`, the
floors, the `handWritten` list) without saying where each comes from, who bumps it, or its exact bytes. Two
verifiers that read those sections differently would disagree on the same file, and a rule that cannot be
tested cannot be enforced. This amendment fixes each. Where a sentence of sections f, h or i conflicts with
it, the sentence is marked "superseded by Amendment 2026-11-02" in place and this amendment governs. The
status stays `proposed`. Each choice below marked "Owner decision" carries a recommended default.

### j. The flow approval revision

1. **Value.** A positive integer, at most 9007199254740991 (2^53 - 1). Zero, negative, fractional and larger
   values are refused when a record is read.
2. **Key.** `(project, flow name)`. `project` is the name of the store's `projects` entry that matched the
   checkout (ADR 0025 section 2; an entry name that passes `NAME_PATTERN`); `flow name` is the `name` field
   of the flow, which must equal the file stem. Both appear in the signed payload as `project` and
   `flowName`, so a record cannot be moved to another project or another name. Two flow files under the flows
   root with the same stem (in different sub-directories) are both `unverified` with note
   `flow_name_duplicate`. This is a pull-request-controlled downgrade that fails closed: adding
   `x/<stem>.yaml` downgrades the verified flow `<stem>`. The rule applies only to files that carry a claim
   (`derived`, a `sourceRef` or a record); a flow with no claim keeps its state (`hand-written` or
   `unclassified`) whatever shares its stem. *Owner decision:* **recommended: refuse duplicate stems** (the key stays the name,
   as `<flowsDir>/<name>.yaml` in the security rules assumes). Alternative: key by the path relative to the
   flows root without extension.
   The `projects` entry name must be identical on every machine that shares a store export, whatever the
   checkout path (a requirement on ADR 0025).
3. **Source.** The approval command (section k) assigns the revision when it signs; nobody types it:
   `revision = max(latestRevision, flowFloors, H) + 1`, where `H` is the highest revision among the records of
   `<flow>.approvals.json` that are **signature-valid** (key in `reviewerKeys` with scope `flows`, not
   expired, not revoked, signature verifies) **and** whose `project` and `flowName` equal the current key.
   Records of another name, records with a bad signature and records with an out-of-range revision do not
   count, so a record appended by a pull request cannot raise the next revision. Each missing value counts as
   0, so the first approval of a name (including a renamed or copied one) is revision 1. The command writes the record
   to `<flow>.approvals.json` first and raises `latestRevision` second. If the second write fails the command
   exits non-zero and says the record exists unrecorded. **Limit:** a revision is not guaranteed never to be
   reused. If the key of the highest record expires or is revoked, `H` drops and a number can repeat. What
   protects is `latestRevision` and the floors on the same machine, which never drop. The file holds at most
   256 records; more is `approvals_too_large` (the flow is `unverified`). **Exits:** a new approval by the
   same key for the same (project, flowName, content hash) **replaces** that key's older record; and
   `flowctl review <flow> --prune` removes every record whose key is revoked or expired or whose content
   hash is not the current one (it signs nothing). `review` prunes first when the file is at 256. A pull
   request that pads the file past 256 is a PR-controlled downgrade that fails closed; `--prune` repairs it.
   A number reused after a revoke, at the same hash, meets the surviving record in `record_tie_conflict`
   when the two disagree (rule 5).
4. **Bump rule.** Every approval bumps it by one, including a re-approval of identical content (the way to
   move a flow to a new reviewer key, section n). A replay, `check` and every `trust` subcommand leave it
   alone. `latestRevision` only goes up: its write function refuses a lower value, and lowering it is the
   owner-signed `trust forget` that ADR 0025 section 3 already requires.
5. **Which record counts.** `<flow>.approvals.json` is an array. The verifier ignores every record that is
   not signature-valid (rule 3) or whose `project`, `flowName` or flow content hash differs from the current
   ones; an ignored record can neither select nor block. A record whose revision is out of range is ignored
   **and** adds the note `revision_out_of_range`. Among the rest it takes the highest revision `h`.
   **Tie:** several valid records may share `h` (two reviewers, or two machines that each approved `n + 1`).
   They must agree on the polarity of every spec item and on the approved baseline value; if they differ the
   state is `unverified` with note `record_tie_conflict`. If they agree, the state is `verified` when `h`
   satisfies the required revision of section l. If no record remains the state is `unverified`. The next
   approval is `max(...) + 1` as in rule 3, whatever the tie.
6. **Rename.** A rename changes the key. The old record names the old `flowName`, so it fails with
   `record_flow_mismatch` and the flow is `unverified`. The new name starts at revision 1 (rule 3) and has
   no floor and no `latestRevision` until the owner sets one (the old file's records do not count towards
   `H`: they name the old `flowName`), so once approved it is `verified` with
   `rollback_not_checked` (section l) until then. The old name's floor and `latestRevision` stay in the store,
   harmless and removable with `trust forget`. Renaming a flow back restores the old key and its floor.
7. **Copy.** A copied file has another stem. A flow whose `name` differs from its stem is `unverified` with
   note `flow_name_mismatch`. A copy edited to the new name changes the content hash, so the record of the
   original does not verify. A copy therefore needs its own approval and starts at revision 1.
8. **Delete and recreate.** Revisions continue: the store's `latestRevision` and `flowFloors` outlive the
   file, and the next approval of that name is above them.

*Owner decision:* source of the number. **Recommended: computed by the approval command from store and
file (above).** Alternatives: counting commits in git (a pull request rewrites history it controls), the
approver's wall-clock time (not monotonic across machines), a number typed by the reviewer (collides).

*Tests:* (a) three approvals of one flow give revisions 1, 2, 3; (b) approve, rename, verify the old record
-> `unverified`, `record_flow_mismatch`; (c) copy the flow and its record to a second stem -> `unverified`,
`flow_name_mismatch`; (d) delete the flow, recreate it with the same name, approve -> revision 4 when the
store held 3; (e) with `flowFloors = 4`, a record of revision 3 -> `unverified`, `revision_below_floor`; (f)
a record with revision `0`, `-1`, `1.5` or `9007199254740992` is ignored and adds the note
`revision_out_of_range`; (g) rename `a` to `b` where `a.approvals.json` held revisions 1 to 5, copied into
`b.approvals.json`: approving `b` gives revision 1; (h) append a record with revision 9007199254740991 and a
bad signature: the next approval is unchanged and the verdict of the flow is unchanged; (i) two valid
records at revision 3 for the same hash that agree: `verified`; if they differ in a polarity:
`unverified`, `record_tie_conflict`; if one has a revoked key it is ignored; (j) 257 records in the file
-> `unverified`, `approvals_too_large`; `review <flow> --prune` leaves only current-hash records of live keys
and the flow verifies again; (k) approving twice with the same key at the same hash leaves one record of
that key, the later one; (l) `x/a.yaml` carrying a claim added beside `a.yaml` -> both `unverified`,
`flow_name_duplicate`; an `x/a.yaml` with no claim changes nothing.

### k. The approval command is `flowctl review`; `trust` never signs

| | `flowctl review` | `flowctl trust` |
|---|---|---|
| Home | logic in `core/src/derive/review/` (T4.5), CLI in `cli/src/commands/review*` (T4.8) | store code (ADR 0025), command registry T1.0 |
| Forms | `flowctl review <flow>` signs a case-approval record (section f); `flowctl review --spec <path>` signs spec metadata (section n). The `--spec` flag form is used so that no flow name can clash with a sub-command word | `init`, `add`, `link`, `hook`, `key`, `ci`, `forget` (ADR 0025 section 3) |
| Key | a reviewer key from `reviewerKeys`: scope `flows` for `<flow>`, scope `spec` for `--spec` | the owner key |
| Writes | `<flow>.approvals.json`, `<spec>.sig`, and **only** a raising write of `latestRevision` | the store, with the owner-key signature per ADR 0025 section 3 |
| Never | any other store section; an owner-key signature | a case-approval record or a spec signature |

Both commands are interactive (nonce on `/dev/tty`, refused without a TTY), never an MCP tool, and guarded
(ADR 0025 section 3: the registry test pins the unguarded list, and `review` is not on it). `latestRevision` is
the one store value `review` writes, as section f already states; the ADR 0025 table should name `review` as
its writer. A `ci` store refuses `review` (it is provisioned elsewhere), so approvals happen on the owner's
machine.

*Tests:* `review` is registered `guarded: true`; run with no store it ends `trust_missing` with no file
touched; `trust` has no sub-command that writes a record or a `.sig`; after `review` the store differs from
before only in `latestRevision`.

### l. Floors in CI, the optional merge-base rule, and `rollback_not_checked`

**Provisioning.** The owner sets floors on the provisioning machine with `trust add floor <flow> <n>` and
`trust add spec-floor <provider/ref> <n>` (owner-key signed) and ships them to the `ci` store with the rest
of it (the export command is task T0.29). A floor only goes up: a value at or below the stored one is
refused, and lowering needs `trust forget` first. `provider/ref` splits at the **first** `/`; provider names
pass `NAME_PATTERN`, which has no `/`, so the split is unambiguous. After every approval `flowctl review`
prints the exact command to raise the floor: `flowctl trust add floor <flow> <revision>` for a flow, and for
a spec document `flowctl trust add spec-floor <provider/ref> <m>` with `m` the **lowest** `metaRevision`
among the operations of that document, so no signed operation is unsigned by it. Printing is advice; nothing
is applied.

*Owner decision:* when floors are raised. **Recommended: at every provisioning of a CI store, to the highest
revision found on the protected branch at that moment** (the store is rebuilt then anyway). Alternatives:
only when a rollback is suspected (the floor then lags every approval since, which is the window section i.1
describes); on every merge (needs automation that does not exist).

**Required revision.** For a flow, `R = max(flowFloors, latestRevision, mergeBaseRevision)` over the values
that exist, and the record's revision must be `>= R` and `>= 1`; a record below `R` gives `unverified` with
note `revision_below_floor`, whichever source set `R`. A source that yields no value is absent, not
0. `rollback_not_checked` is present in `provenanceNotes` **if and only if all three are absent**; this
replaces the two-source wording of section i.1.

**The merge-base rule (optional, off by default).** Enabled by `--merge-base <ref>` on `replay` and
`check`, and nothing else turns it on. Inside flowctl it can only tighten: `R` is a maximum, so it never
lowers the store's floor. **Its limits are about who chooses the inputs.** A pull request chooses its own
fork point and, if it can edit the workflow, the flag. So: (i) CI must run on the **merge result** of the pull
request into its target, or must pass the target branch tip explicitly as `<ref>`; a pull-request branch
forked from an old commit and checked out as is gives an old `base`; (ii) `--merge-base` must be set by a
**protected workflow** (CODEOWNERS and branch protection on `.github/`, ADR 0025 section 3) and not by anything
the pull request controls; a pull request that can edit the workflow can drop the flag, and then only the
store floor protects. This rule is defence in depth behind the floor, not a replacement for it. Rule:

1. Resolve `git merge-base --all HEAD <ref>`, run with the scrubbed git environment of ADR 0025 section 1
   (only the fixed `PATH`, passwd `HOME`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_CONFIG_NOSYSTEM=1`, `--git-dir`).
   Shallow repositories are already refused (`identity_unverifiable`).
2. Read `<flow path>.approvals.json` at each base with `git show <base>:<path>` (a git object the pull
   request cannot rewrite), at most 1 MiB of output (more is `merge_base_record_invalid`).
   `mergeBaseRevision` is the highest `revision` integer over the bases where the file exists (several bases
   happen after a criss-cross merge; a base without the file is skipped); only the integers are read and no
   signature is checked, because the base is the protected branch. A `<ref>` that starts with `-` is
   refused as a usage error.
3. File absent at `base` (a new flow, or a flow renamed in this pull request): `mergeBaseRevision` is
   absent. A rename therefore escapes this rule; the store floor of the new name is the control (a stated
   limit).
4. The failure modes are: `<ref>` does not name a commit; the two histories have no common ancestor (the
   command prints nothing); git exits non-zero. Then every flow **that carries a claim and whose record would
   otherwise verify** is `unverified` with note `merge_base_unresolvable` (fail closed). A `hand-written` or
   `unclassified` flow has no record and is not affected.
5. A base file that is not valid JSON, or holds a `revision` that is not a positive safe integer (zero,
   negative, fractional, or above 9007199254740991), gives that flow `unverified` with note
   `merge_base_record_invalid`. The base file is unsigned, so a bogus huge value there is a **denial of
   service that fails closed for that flow**, never an escalation: no value can make a flow `verified` that
   would not be without the rule. Whoever can commit such a file to the protected branch can already merge.

*Owner decision (this is section i.1 decision (b)):* **recommended: adopt it when T4.5 lands, in the `ci`
workflow only.** Alternative: never adopt it and rely on floors.

*Tests (record revision r):* floor 4, r = 4 -> `verified`; floor 4, r = 3 -> `unverified`
`revision_below_floor`; floor 4, latest 6, r = 5 -> `unverified`; no floor, latest 6, r = 6 -> `verified`;
no floor, no latest, base file has 5, `--merge-base` on, r = 5 -> `verified`, r = 4 -> `unverified`; nothing
anywhere, r = 1 -> `verified` with `rollback_not_checked`; `--merge-base` on, a flow absent at base and no
floor -> `rollback_not_checked`; a base file of 1 MiB + 1 byte -> `merge_base_record_invalid`; `--merge-base
-x` -> usage error `merge_base_ref_invalid`.

**What `rollback_not_checked` does to a report total.** It never changes a verdict, an exit code or the
state. The report and `run.json` carry `provenanceTotals` with these integer fields: `verifiedChecked`
(`verified` with neither `rollback_not_checked` nor `spec_rollback_not_checked` in its notes; other notes do
not matter), `verifiedUnchecked` (`verified` with either), `handWritten`, `unverified`, `unclassified`. The headline "verified" figure in the summary and the report is **`verifiedChecked` only**;
`verifiedUnchecked` is printed on its own line as "verified, floor missing" (it covers both `rollback_not_checked` and `spec_rollback_not_checked`).
`revision_out_of_range` is a note only and does not change the state. Any "derived from spec"
total counts `verifiedChecked` only. The sum of the five fields equals the number of flows the command looked at: the flows executed by `replay`
and `run`, and every flow discovered by `check` (which executes none; there the totals describe the
repository, not a run).
*Owner decision:* **recommended: the headline counts `verifiedChecked` only** (a total that counts flows
whose rollback was not checked overstates the assurance). Alternative: count both in one figure with a
marker. Section i.1 decision (a) stays as written: with no floor, CI labels (recommended) or fails.
*Test:* three verified flows, two with a floor and one without -> `verifiedChecked: 2`,
`verifiedUnchecked: 1`, headline 2.

### m. Canonical JSON, profile `flowctl-canonical-json/1`

Everything this amendment hashes or signs as JSON uses this profile, byte for byte. It is used for the
`context` object (i.3) and the signed spec unit (section n). The case-approval payload of section f keeps its
own length-prefixed encoding.

1. **Types allowed:** object, array, string, integer, `true`, `false`, `null`. A value of any other type
   (`undefined`, a function, a symbol, a `Date`) is refused with `canonical_type_refused`. **Every number or
   big integer that is not an integer in the range of rule 6 (a float, `NaN`, `Infinity`, an integer above
   2^53 - 1) is `canonical_number_refused`**, never `canonical_type_refused`.
2. **Output:** UTF-8, no byte-order mark, **no whitespace anywhere outside strings**, no trailing newline.
3. **Objects:** `{`, members joined by `,`, `}`. A member is `"key":value`. **Members are sorted by the
   bytes of the key's UTF-8 encoding, ascending** (byte comparison; on a common prefix the shorter key
   first). A duplicate key is refused when a file is parsed. Keys are NFC-normalised before sorting; two keys
   that become equal after NFC are refused with `canonical_duplicate_key`.
4. **Arrays:** `[`, elements in the given order joined by `,`, `]`. Order is semantic and is never sorted
   (`headings` is outermost first; `expected` is in the provider's order).
5. **Strings:** first normalised to **NFC**. A string with a lone surrogate is refused
   (`canonical_invalid_string`); input bytes that are not valid UTF-8 (a `.sig` or provider payload) are
   refused with `canonical_invalid_utf8` before any parsing. Output is `"`, then each code point: `"` as `\"`; `\` as `\\`; U+0000 to
   U+001F as `\u` plus four **lowercase** hex digits (there are **no** short forms such as `\n`); every
   other code point, U+007F, U+2028 and non-BMP ones included, as its raw UTF-8 bytes; then `"`.
   Whitespace inside a string is kept exactly. Only NFC is applied here; the whitespace collapsing and the
   refusals of section d belong to quote comparison and do not run in this profile.
6. **Integers:** decimal digits, a `-` only if negative, no leading zeros, no `+`, no exponent, absolute
   value at most 2^53 - 1; `-0` and anything outside the range is `canonical_number_refused`. **Lexical
   form in a parsed file:** a number token must match `-?(0|[1-9][0-9]*)` exactly. `3.0`, `1e0`, `1E2`,
   `-0`, `+1`, `01` and `.5` are refused with `canonical_number_refused` even though a JSON parser reads some
   of them as integers; a `.sig` holding one is malformed (section n).
7. **Null and absence.** A field that the schema lists but whose value is absent is written as `null`,
   never omitted, so the key set of every object is fixed by the schema. `null` is not the empty string and
   is never coerced to or from it: `leadIn: null` and `leadIn: ""` give different bytes. A provider returns
   `null` for a missing lead-in (ADR 0023), never `""`.
8. **Numbers in spec items.** In the signed unit, an expected item's `value` must be a string or `null`; a
   JSON number there is refused with `canonical_number_refused` (rule 1 allows in-range integers elsewhere,
   for example `metaRevision`). A provider whose source has a number (for example `12.5`) passes its text
   form as the string `"12.5"` (section d binds the number to a unit and a locale by parsing that text).
   **Scope of every `canonical_*` refusal:** it makes the one operation (or document) it occurs in unsigned
   with a note code, and a flow approval record it occurs in is ignored with the note
   `record_canonical_refused` (the flow is then `unverified` if no other record remains); it never aborts a
   command, except a `review` run that is building a unit, so a pull request that edits a spec cannot abort a whole
   `check` or replay. Where a command does abort (section p), the cause is the command's own input. *Owner decision:* **recommended: string-only.**
   Alternative: allow integers only and refuse the rest, which would make `12` and `12.5` behave differently.
9. **Why NFC here and a refusal of NFKC-different text in section d.** The two rules act on different
   inputs. Section d judges a quote or an expected value and refuses text that NFKC would change (a
   compatibility trick). This profile only fixes the bytes of an already accepted string; it uses NFC and
   never NFKC, because NFKC would merge distinct strings into one signed value. ADR 0024 uses NFC and no NFKC
   for paths for the same reason. A Unicode release can change NFC for rare code points; that is a
   deferred limit (the digest then changes and reads as unsigned or `stale_sourceRef`, fail closed).
10. A hash in this ADR over canonical JSON is the `sha256` of those bytes, with no prefix, written as 64
   lowercase hex digits.

**`context`** (i.3) is the object `{ headings, leadIn, operationId, operationTitle }` (that is its sorted key
order) and `contextSha256` is the sha256 of its canonical bytes.

*Worked example.* Input (the title is given in decomposed form, `a` followed by U+0323, so NFC applies):

```
headings:       ["Orders", "Tạo đơn"]
leadIn:         null
operationId:    "create-order"
operationTitle: "Tạo đơn"
```

Canonical bytes (111 bytes, one line, no newline):

```
{"headings":["Orders","Tạo đơn"],"leadIn":null,"operationId":"create-order","operationTitle":"Tạo đơn"}
```

`contextSha256` = `81e0ff4d334d94b34bd51ee88d9e773a45409c3442938606c85b39f897e00c0a`
(computed with `shasum -a 256` over a file holding exactly those 111 bytes, and with a reference
implementation of the profile; both agree). The tail of the title is the bytes `54 e1 ba a1 6f 20 c4 91 c6
a1 6e`: `T`, U+1EA1 as one code point, `o`, space, `đ`, `ơ`, `n`; there is no U+0323 left.

With `"leadIn": ""` instead of `null` the bytes differ at that member and the digest is
`b639b310983660671883af3bb7d522043f297b86390da95dfa83c49a311bbab8`. Renaming the ancestor heading gives a
different digest; that is the `context_changed` case of i.3.

*Failing inputs:* `{"a":1.5}` -> `canonical_number_refused`; `{"a":undefined}` -> `canonical_type_refused`;
a string holding U+D800 alone -> `canonical_invalid_string`; `{"a":-0}` -> `canonical_number_refused`.
Escape rule: the object with member `b` = the 7-character string `a`, `"`, `b`, `\`, `c`, U+0007, `d`, and
member `a` = `[1,true,null,-5,0]` serialises to `{"a":[1,true,null,-5,0],"b":"a\"b\\c\u0007d"}`.

### n. Spec signatures: file shape, signed unit, several keys, rotation, `metaRevision`

**The signed unit** (supersedes the unit named in i.2). It is the canonical JSON (section m) of an object
with exactly these ten keys, listed in sorted order: `actor`, `author`, `expected`, `id`, `language`,
`metaRevision`, `provider`, `ref`, `review`, `title`.

- `provider` and `ref` are the operation's `location` (ADR 0023 amendment). `ref` is the document-level
  reference, **without** a line range or revision; for a markdown source it is the path relative to the
  `specs` root, with `/` separators and no leading `./`.
- `id`, `title`, `actor` come from the provider's `Operation`; `actor` is `null` when the provider has none.
- `expected` is the provider's array. Each element is exactly `{ context, text, value }`; `value` is a
  string, or `null` when the item declares none (section m, rule 8). ADR 0023's `value?` maps as follows: an
  absent `value` is written as `null`, never omitted. The item's own `ref` (line range, revision) is **not** signed, because it
  moves with every edit above it, while the text, value and context are.
- `author` is `human`, `agent` or `person:<name>` (name: NFC, 1 to 128 code points, none refused by
  section d); `review` is `reviewed` or `unreviewed`; `language` is the language code; `metaRevision` is the
  integer defined below. **`preconditions` and `steps` are not signed** (see the limits below).

**The message** signed is the bytes `flowctl/spec-unit/v1`, one `0x00` byte, then the canonical bytes
(domain separation from case approvals). The algorithm is Ed25519 as in RFC 8032 (pure). A `keyId` is the
sha256, 64 lowercase hex digits, of the raw 32-byte public key. A signature is standard base64 with padding
(88 characters).

**The `.sig` file** (supersedes the map of i.2). `<spec path>.sig`, UTF-8 JSON, at most 1 MiB, parsed safely
(ADR 0023 provider rule 4; a duplicate key is refused):

```
{ "format": 1,
  "operations": {
    "<operationId>": [
      { "keyId": "...", "signature": "...", "metaRevision": 3,
        "author": "human", "review": "reviewed", "language": "en" } ] } }
```

Each entry carries the claimed `author`, `review`, `language` and `metaRevision`: the verifier needs them to
rebuild the signed bytes, and trusts them only if the signature over them verifies. An operation has at most
8 entries. **A malformed file is wholly unsigned** with note `signature_malformed` (`signature_too_large`
when over 1 MiB): invalid UTF-8, a duplicate key, an unknown top-level key, a `format` other than 1, a
number token outside the lexical form of section m rule 6, or more than 8 entries for any operation. A provider that is not a file supplies the same bytes through `signatureRef` (ADR
0023 amendment).

**Verification of one operation.** An entry is *valid* only if every step holds:

1. `keyId` is in `reviewerKeys` with scope `spec`, not expired and not revoked at the verifier's clock.
2. `metaRevision` is a positive safe integer and `>= specFloors[provider/ref]`. A missing floor counts as 1
   and adds the note `spec_rollback_not_checked`.
3. `language` equals the store's per-project `language` (else the metadata reads as unsigned, as i.2 states).
4. The unit rebuilt from the **current** operation and the entry's claims, framed as the message above,
   verifies under the key.
5. If `author` is `person:<name>`, `<name>` equals the person registered for that key in `reviewerKeys`
   (ADR 0025 stores a person per key), compared after NFC. Otherwise a signer could attest as someone else.

The result is taken from the valid entry with the highest `metaRevision`. If two valid entries share that
`metaRevision` and differ in `author`, `review` or `language`, the operation is unsigned with note
`spec_sig_conflict`. A per-operation code (`spec_sig_conflict`, `spec_rollback_not_checked`,
`signature_unavailable`, `signature_malformed`, `spec_canonical_refused`, `spec_path_not_nfc`) is added
**once** to the `provenanceNotes` of every flow that has a `sourceRef` into the affected operation or
document, sorted in byte order. It stays per flow because `provenanceTotals` (section l) is per flow; the
report prints each affected document once, and `run.json` details name the operations. With no valid entry the metadata reads `author: unknown, review: unreviewed` and counts
as agent-written, as i.2 states.

**`metaRevision`.** An integer **chosen by the signer**, not derived. `flowctl review --spec` proposes
`max(highest metaRevision in the existing entries for that operation, specFloors[provider/ref], the
metaRevision of any entry dropped in the same run) + 1` (1 if there is none) and accepts a larger integer typed by the signer; it refuses a smaller one. It is bumped on
every re-signing of that operation, whatever the reason (an edit, a new key, a changed `review`). The floor
is per document, not per operation, and only the owner raises it (section l). A floor protects against an
**old legitimate signature** restored together with old text; it does not protect against a stolen key,
which can choose any `metaRevision`; revocation does. **Re-signing by the same key replaces that key's old
entry for the operation** (it does not append), so the cap of 8 is per distinct key. When 8 distinct keys
already have an entry, `review --spec` refuses with `sig_entries_full` and prints the retry
`flowctl review --spec <path> --drop-key <keyId>`. `--drop-key` is an option of the signing run: it removes
every entry of that key and signs in the same run, so the proposal above sees the dropped revisions and
cannot go lower than them. It requires the dropped key to be revoked or expired in the store, else the run
refuses with `drop_key_active`. If all 8 keys are still live, the owner must first run `trust key revoke`
for one of them; there is no other way out, by design.

**Limits, stated plainly.**
1. **`steps` and `preconditions` are outside the signature.** The meaning of an approved `expected` item can
   change through `Operation.steps` and `Operation.preconditions` (the "when" the sentence applies to) while
   the signature stays valid, and the reviewer's approval does not cover them. Only `expected[].text`,
   `value`, `context`, `title`, `actor` and the ids are bound. *Owner decision:* **recommended: leave
   unsigned for now**, because their normalised shape is not fixed by ADR 0023. Alternative: add both to the
   unit as arrays of NFC strings (changes the ten keys to twelve and every digest above).
2. **The floor is per document** (its lowest `metaRevision`). An operation signed at 7 in a document whose
   floor is 3 can be rolled back by a pull request to its own signed revision 3 to 6, or to any older valid
   entry still above the floor.
3. **Deleting the newest entry reveals an older valid one** (a same-text downgrade of `author` or `review`
   from `human, reviewed` back to what an older entry said). Nothing records that a newer entry existed. The fix
   would be a signed negative record (a retraction listing superseded `metaRevision` values); deferred, not
   built.
4. **A pull request can pad one operation to 9 entries**, which makes the whole file unsigned
   (`signature_malformed`). That is a PR-controlled downgrade that fails closed.
5. **The clock is a trust assumption.** Key expiry is judged against the verifier's clock; a runner with a
   wrong clock accepts an expired key or rejects a valid one.
6. **A stolen reviewer key** signs anything until revoked (as i.2 states).

**Rotation.** (1) `trust key add` registers the new key with scope `spec`. (2) `flowctl review --spec`
signs every operation with the new key, bumping `metaRevision`, and adds its entry beside the old key's
entry (a different key adds; the same key would replace). (3) Once every operation has a valid new entry, the owner revokes the old key or lets it expire; the
old entries then fail step 1 and may be deleted. (4) The owner raises the floor (section l). Expiry is
judged at verification time against the verifier's clock, because a signature carries no trusted timestamp,
so signatures must be renewed before a key expires. A compromised key is revoked at once; its signatures fail
from the next store read. Flow approval records follow the same pattern: re-approval with the new key is the
next revision (section j, rule 4).

*Worked example (signed unit).* Input: provider `markdown`, ref `specs/orders.md`, id `create-order`, title
`Tạo đơn`, actor `Sales clerk`, one expected item with text `The order appears in the list.`, no
declared value, and the `context` of section m; author `human`, review `reviewed`, language `en`,
`metaRevision` 3. Canonical bytes (371 bytes):

```
{"actor":"Sales clerk","author":"human","expected":[{"context":{"headings":["Orders","Tạo đơn"],"leadIn":null,"operationId":"create-order","operationTitle":"Tạo đơn"},"text":"The order appears in the list.","value":null}],"id":"create-order","language":"en","metaRevision":3,"provider":"markdown","ref":"specs/orders.md","review":"reviewed","title":"Tạo đơn"}
```

sha256 of those bytes: `2dd9c1d551ccceeaa50c2cd2622c05e689e6483f15e71d6c4ed95ac876fc0329`. sha256 of the
message (tag, `0x00`, bytes): `fa611df752546ae10e8027b43d3918ef011d8bfd06dfd85d6e79b6b694106120`.
A verify-only test vector for that message (a throw-away key; its private half was not kept):

```
publicKey (raw, hex): 423357a9d63cd783e30903088961e8df3d6c452665191367995941d6938ab4d4
keyId:                19c6cfb020a6c58e242defd435b3aaf88f0f80c17a5cadbcbe118a77c09b104d
signature (base64):   kQ6arEJ8NzFEVgDEuQnXnamb4NvlMWIRmuRlw6Wx42tZJF940yV4s9FIrDDm0h2kvQA1ObDbFdk1m8PByc64Dg==
```

*Tests.* Passing: the vector above verifies with `metaRevision` 3 and floor 3 or unset. Failing: floor 4 ->
unsigned; `leadIn` changed to `""` -> unsigned (the bytes differ); entry for another document (`ref`
changed) -> unsigned; ancestor heading renamed -> unsigned, and `check` reports `stale_sourceRef` with reason
`context_changed`; entry `language` `vi` with store `en` -> unsigned; key revoked -> unsigned; two valid
entries with equal `metaRevision` and different `review` -> unsigned, `spec_sig_conflict`; a ninth entry ->
whole file unsigned; old key revoked and a new key's entry present -> the new entry is used; the same key
signing twice leaves one entry of that key; 8 live keys then a ninth signer -> `sig_entries_full`, and
`--drop-key` of a live key -> `drop_key_active`, of a revoked key -> succeeds with `metaRevision` above the
dropped one. T4.5 pins these
vectors as tests in `core/test/provenance/`.

### o. How a CI runner gets the `handWritten` list

The owner classifies on their machine (`trust add handwritten`, T4.16), which writes owner-signed entries
(path plus closure digest) into the owner's store. A CI runner reads only its own `ci` store (ADR 0025), so
the classification must travel there. **The classification export is a part of the CI store build** that task
T0.29 specifies (`trust export --for-ci`); this section fixes what the export must contain and how it
behaves.

1. **Content.** The export copies the `handWritten` section as it stands in the owner's store at export
   time, each entry keeping its owner-key signature. The runner verifies them against the owner public key
   pinned in its store on every read (ADR 0025 section 3). **One unsigned or wrongly signed entry rejects the
   whole bundle** with `trust_tampered`; it is never skipped entry by entry. The `classification` marker is
   copied **as the owner's store holds it**: `enforce` only if the owner ran the signed `flowctl trust ci
   --enforce-classification` before the export, and absent otherwise; the export sets nothing itself. The
   export does **not** copy `latestRevision` (it is per machine and written only by `flowctl review`; ADR 0025
   section 3 export never writes it); rollback protection on a runner comes from floors (section l).
2. **Key of an entry.** The path **relative to the project's `flows` root**, `/` separators, plus the closure
   digest. The export carries these keys **unchanged**; it does not rewrite them for the runner. The runner's
   checkout path does not matter for this section; the project entry must still match the runner's checkout
   (ADR 0025 section 1), and its **entry name must be the same on the runner as on the owner's machine**, since
   floors and records are keyed by it (section j).
3. **Replacement, not merge.** An export replaces the CI store's `handWritten` section as a whole, so an
   entry the owner removed with `trust forget handWritten` disappears from CI at the next export.
4. **Effect of an edit.** A pull request that edits a hand-written flow, or a file its hooks call, changes
   its closure digest; that flow is `unclassified` in CI until the owner re-classifies it and re-exports.
   This is intended: an edit to hand-written content is a new classification event. Under `classification:
   enforce` that pull request fails with `provenance_unclassified`; without it the flow is only labelled.
5. **Limit (deferred):** entries are keyed by the flows-root-relative path, so two flows that share a stem
   in different directories are classed by path and can differ from the name-keyed floors of section j.
6. **No export, no list.** A CI store without a `handWritten` section classes nothing: every flow without a
   claim is `unclassified`, every flow with a claim is `unverified`. Nothing is read from the repository.

*Owner decision:* **recommended: export on every provisioning of the CI store, together with the floors of
section l.** Alternative considered and rejected: an owner-signed manifest file in the repository. It would
let a pull request carry the list, but it adds a second place to verify, and a restored old manifest classes
old content the same way a store entry does; the store is already the anchor.
*Tests:* classify two flows, export, edit one in a branch -> the edited flow is `unclassified` and the other
`hand-written`; `trust forget` one, export again -> it is `unclassified`; one entry with a broken
signature among ten -> the whole bundle is rejected, `trust_tampered`, and no entry is honoured.

### p. Codes introduced or fixed by this amendment

One list, so a test can pin it. **Notes in `provenanceNotes`:** `record_flow_mismatch`, `flow_name_mismatch`,
`flow_name_duplicate`, `revision_below_floor`, `revision_out_of_range`, `merge_base_unresolvable`,
`merge_base_record_invalid`, `spec_sig_conflict`, `spec_rollback_not_checked`, `signature_unavailable`,
`signature_malformed`, `signature_too_large`, `spec_canonical_refused` (any `canonical_*` refusal while
building or checking a signed unit or `context`; the specific code goes in `run.json` details),
`spec_path_not_nfc` (ADR 0023), `record_tie_conflict`, `record_canonical_refused`, `approvals_too_large`, with `rollback_not_checked` and
`freshness_not_checked` as before. A note never aborts a command. **Errors** (the command exits non-zero;
these come from the command's own input or store, not from repository content): `canonical_type_refused`,
`canonical_number_refused`, `canonical_invalid_string`, `canonical_invalid_utf8` and `canonical_duplicate_key`
(when `review` builds a unit, or a test calls the profile directly), `sig_entries_full`, `drop_key_active`, `merge_base_ref_invalid` (a usage error),
`review_refused_on_ci_store` (a `review` run against a `ci` store; `store_writable_in_ci` is a different
case, a writable store), `trust_missing` (any guarded command, `review` included, with no store) and
`trust_tampered` (a bad export bundle).
