---
type: ADR
id: "0039"
title: "A reviewer key lives at most 365 days, and its custody is recorded as an owner declaration, not a fact"
status: proposed
date: 2026-11-13
---

## Context

Reviewer keys (ADR 0025 section 3, task T1.15) sign approvals that other people's flows and spec metadata depend on.
Two choices in the first implementation need a written reason, because ADR 0025 does not state them and a reader of
the trust store could take them for guarantees they are not.

## Decision

1. **Lifetime cap.** `--expires` is a whole number of days from 1 to 365, with no default; the owner always names it
   (`MAX_KEY_DAYS`). A year bounds how long a leaked or forgotten key keeps working if nobody revokes it, and forces a
   periodic look at who still holds a key. Several active keys per person and scope are allowed, so rotation can
   overlap. The cap is enforced when the entry is written. The signed entry carries the expiry, so an edit to it
   fails the owner signature; the read does not recompute the length. A longer life is a change to this decision, not
   a flag.
2. **Custody is what the owner said.** `trust key new` writes the sealed key file itself and records custody `file`.
   `trust key add` registers a public key whose private half flowctl never sees; its `--custody file|hardware` is a
   declaration that flowctl cannot verify, so the store records `declared-file` or `declared-hardware`, and the
   command's screen and output say "declared by owner, not verified". Custody is never an input to whether an
   approval verifies: only the signature, scope, expiry and revocation decide that.
3. **No unencrypted file key.** `trust key add` takes public key material only and refuses a file holding private
   key material unread; the public file is opened without following symlinks and read as a regular file of at most
   4 KiB.

## Consequences

- A store entry with `declared-hardware` is a record of a statement, not evidence of a device. A reviewer of the store
  must not rely on it as proof of custody.
- Strengthening custody (for example an attestation from a hardware token) would be a new value and a new decision.
- Entries written before this decision with custody `hardware` or `file` by `trust key add` do not exist: the feature
  has not shipped.
