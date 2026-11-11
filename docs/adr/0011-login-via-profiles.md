---
type: ADR
id: "0011"
title: "Log in only through profiles/storageState"
status: accepted
date: 2026-10-03
---

## Context

Jev's `snapshot.js` deliberately hides password fields, so System 1 cannot log in by itself. Passwords
must also never pass through any model. ERP flows often involve several profiles (submit a request, then approve it).

## Decision

**Login is not a step of a flow. The user runs `flowctl login <profile> --env <env>`,
logs in manually in the browser, and flowctl saves the storageState to `<flowsDir>/.auth/<env>/<profile>.json`
(gitignored). A flow picks its profile with `profile` and switches profile midway with an `as: <profile>` step.
If the session is missing or redirects to `loginUrl`, return `error: profile_expired` with the command to run.**

## Options considered

- **Profile + storageState** (chosen): credentials never pass through flowctl or a model; multi-profile flows stay simple.
- **Log in inside the flow with `{ env: PASSWORD }`**: works without preparation, but every
  run costs extra steps and the password passes through the executor.

## Consequences

- **Easier:** the same yaml runs on local and staging (sessions are split per env); `as:` covers
  submit → approve flows.
- **Harder:** an expired session needs a manual re-login; CI needs its own way to create storageState
  (for example a seed script like `test/helpers.ts`).
- **Revisit when:** the app uses SSO/2FA that storageState cannot persist.

## Amendment 2026-10-29

Saved sessions move out of the repository into the trust store's `sessionDir`, filtered to the profile's
origins ([ADR 0024](0024-target-scope-and-guards.md) section 4, [ADR 0025](0025-trust-store.md)). The manual
`flowctl login` writes there too, CI reads its sessions from the same `sessionDir` of its provisioned store,
and task T1.4 changes `storageStatePath` in `config.ts` accordingly. The in-repo `.flows/.auth/` path is
legacy and refused once a store exists. Both ADRs are `proposed` until the owner accepts them.
