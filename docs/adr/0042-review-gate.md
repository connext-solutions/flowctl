---
type: ADR
id: "0042"
title: "A case approval signs a fixed length-prefixed payload; the review gate re-does the work and raises only latestRevision"
status: proposed
date: 2026-11-16
---

## Context

ADR 0020 section f says a person signs a case-approval record with an Ed25519 key, over "a length-prefixed canonical
encoding", and Amendment 2026-11-02 sections j, k and l fix the revision, the command and the required revision. Two
things were left open: the exact bytes that are signed, and who may write `latestRevision`, since the store file is
owner-signed and a reviewer key is not the owner key. T4.5 builds the verifier (`core/src/provenance/`) and the
approval workflow (`core/src/derive/review/`); both need these two answers before a signature exists.

## Decision

1. **The signed bytes.** `encodeApprovalPayload` (`provenance/payload.ts`) writes, in this order: the domain tag
   `flowctl-case-approval/1`, a version byte (1), `project`, `flowName`, the flow content hash, the revision as a
   decimal string, the key id, `approvedAt` (ISO, millisecond, `Z`), the list of assertions, the list of confirming
   replay hashes, the AppMap evidence hash and the optional baseline. A field is a 4-byte big-endian length and its
   UTF-8 bytes; a list is its count (4 bytes) then its items; an optional field is a presence byte, then the field.
   An assertion is its hash, its optional `sourceRef`, its polarity and its optional `number`. Text must be NFC and
   free of invisible code points (ADR 0020 section d); a `sourceRef` and a `number` are canonical JSON
   (`flowctl-canonical-json`, `trust/canonical.ts`). The tag and the lengths make a payload unambiguous: moving a byte
   from one field to the next changes the bytes. A change to this layout is a new tag (`/2`), never an edit.
2. **Hashes.** The flow content hash is sha256 of `flowctl-flow-content/1`, a line feed and the canonical JSON of the
   parsed flow without `file`, `parsedSteps` and `sourceSha256`, so layout and key order do not matter and any change
   to a step, input, assertion, `sourceRef` or marker does. A hook's bytes are not in it: the hook closure digest of
   ADR 0021 covers them under the owner's consent. An assertion hash and an evidence hash have their own tags.
   Replay hashes are the evidence hash of a redaction-safe summary that the review process computes itself.
3. **What the verifier checks** (`provenance/verify.ts`, `approval-state.ts`): a record counts when it parses, its
   revision is an integer in 1..2^53-1, its key is a `flows` key in the store that is not expired or revoked, its
   signature verifies, and its `project` and `flowName` are the current ones. It selects only when its flow hash and
   assertion hashes are the current flow's. Several records at the highest revision must agree on the polarity and
   number of every assertion and on the baseline value (`record_tie_conflict`). The required revision is the
   maximum of the floor, `latestRevision` and a caller-supplied merge-base value, and `rollback_not_checked` is a
   note if and only if all three are absent (section l). More than 256 records is `approvals_too_large`. `provenance/`
   never spawns git: the merge-base value and the duplicate-stem fact are inputs.
4. **Who writes `latestRevision`.** `raiseLatestRevision` (`trust/revision.ts`) is the only writer besides the
   owner-signed `trust forget`. It takes no key: the section is a plain record, not an owner-signed entry kind, and
   ADR 0025 section 3 lists only its reset as owner-signed. It refuses a `ci` store and a lower value, does nothing
   for an equal one, and goes through the same locked, hash-chained, anchored write as every store change. An editor
   with the same user rights can still rewrite the store (ADR 0025 section 6); the control that holds is that a
   record needs a key the generator never has. The ADR 0025 table should name `review` as the writer of
   `latestRevision` (section k of ADR 0020 already says so).
5. **The approval workflow** (`derive/review/approve.ts`) refuses with no store (`trust_missing`), on a `ci` store and
   with no terminal (`tty_required`) before touching a file; re-resolves every `sourceRef` and runs the confirming
   replays (two by default) in its own process, taking no hash from the generator; shows a screen built only from
   signed fields, each text an escaped code span; asks for a nonce; reads the passphrase from the terminal with echo
   off; checks the key is a valid `flows` key; signs; writes `<flow>.approvals.json` first and raises
   `latestRevision` second (a failure of the second is `latest_revision_unrecorded`, and the record stays). A full
   file (256) is pruned first. The terminal, the signer and the replayer are injected: `flowctl review` and the
   `/dev/tty` code are T4.8. A baseline must be among the values the replays and the map showed
   (`baseline_mismatch`); generator output that already holds a baseline reference or an approval is rejected.
6. **The label.** `provenanceState(flow, flowsRoot, store, verify?)` returns `verified` only when `verify` (the store
   and the project name) is given and a record passes; without it a claim stays `unverified`. `labelFlow` passes the
   checkout root, finds the project with `projectFor`, and labels only a flow that claims a derivation or has an
   approvals file. The label never changes a verdict (ADR 0004).

## Options considered

- **Signing canonical JSON of the whole record.** One encoder for everything, but JSON has many spellings of one value
  and no field boundary a signature can rely on across implementations. Rejected; canonical JSON is used only inside
  the two nested objects.
- **An owner-signed raise of `latestRevision`.** Needs the owner key at every approval, which is the opposite of
  section k (the reviewer, not the owner, approves). Rejected.
- **A separate counter file for revisions.** A second place to roll back and to keep in step; the store already has the
  section and the anchor. Rejected.
- **Spawning git in `provenance/` for the merge base.** Breaks the layer's purity and the spawn rules of ADR 0035.
  Rejected; the CLI passes the value.

## Consequences

- **Easier:** T4.8 wires a terminal, a key file and a replay into `approveCase` and prints `floorCommand`; T4.3
  calls `verifyBaseline` and `rejectPreApproved`; T4.14 counts `verified` flows from the label.
- **Harder:** the payload layout is frozen by golden tests; a field added later needs `/2`. A reused revision after a
  key revoke is possible on a machine with no `latestRevision` (ADR 0020 section j limits).
- **Revisit when:** a hardware signer exists (it only has to implement `ReviewerSigner`), or the owner decides the
  merge-base rule is on by default.
