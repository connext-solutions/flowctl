---
type: ADR
id: "0024"
title: "Target scope, credentials and run guards, anchored in the trust store"
status: proposed
date: 2026-10-29
---

> Owner acceptance: direction approved 2026-10-30 (tasks T0.10, T0.15); text including the 2026-11-01 amendments accepted 2026-11-02. The status is `proposed` and stays so until the decision is implemented (`docs/adr/README.md` reserves `accepted` for that); no code exists yet. The #41 choice in section 7 was decided separately on 2026-10-30 (task T0.12): Option A.

> Interim implementation (2026-11-04, owner request "protect stg before agents write"): the UI-level part of
> section 5 only, for explorations. `ActionGuard` (`core/src/explore/guard.ts`) checks the label of an action
> control (button, link, menu item, switch, checkbox, option; not fields, cells or tabs) against a core word list
> (tokenised, Vietnamese included, minus a few safe phrases such as "Gửi duyệt" and "Người duyệt") before System 1
> or the orchestrator clicks it, selects it, or presses Enter on it or in its form. On an env the trust store
> classes `shared`, System 1 never takes such an action and the orchestrator only with `allowDestructive` on the
> request; on `production` (any scheme or port of a production host) and on a non-loopback origin the store does
> not list, nobody may, and the run escalates `destructive_action`. Not yet: the request layer (a `goto` to a GET
> that changes data passes), the `destructiveConfirm` entries and run ledger, icon-only controls, hover and drag,
> and replay (a saved flow does what its reviewed file says). `allowDestructive` is set by the orchestrator, so it
> stops accidents by System 1, not a hostile caller; the full section 5 replaces it (T1.3).

## Context

Observe will visit pages on its own, Derive will write flows that click and submit, and Execute runs them
with a model choosing controls. Today the limits are `system1.allowedEnvs` (ADR 0005) and profiles saved by
a person (ADR 0011). Three things become dangerous once a crawler and generated flows exist:

- **Scope.** A link to another origin, a popup, a `javascript:` or `data:` URL, or a protocol-relative
  `//host/path` can leave the app. A path-only check lets all of them through (issue #40).
- **Credentials and sessions.** Automated login needs a password; a saved session holds cookies for the
  target and must not travel to another origin (issue #50).
- **Blast radius.** A crawler or a model can click "Delete", "Pay" or "Send" on a shared environment, and a
  flow's `inputs: { env: NAME }` can read any environment variable (issue #41).

An earlier draft compared these against values in `target.yaml`, which a pull request can edit. ADR 0025
moves every trust anchor to a per-machine store.

**Acceptance criterion: a pull request, or a script supplied by the repository, cannot loosen any guard,
redirect any credential or forge any approval, assuming the agent cannot execute arbitrary commands as the
owner outside the harness (ADR 0025 section 6 says what holds against a same-user agent with a shell).** Red
tier: the owner reads it before acceptance. This ADR is accepted only together with ADR 0025, its anchor.

## Decision

### 1. One configuration file, anchored in the trust store

There is **one repository file: the existing `flowctl.config.yaml`** (`packages/core/src/config.ts`, schema
`.strict()`: `defaultEnv`, `envs`, `profiles`, `system1.{baseUrl, apiKeyEnv, model, confidenceThreshold,
allowedEnvs}`). The roadmap's "target.yaml" is not a second file: it is a `target:` section added to it
(scope, budgets, extra destructive words, login recipe per profile) and new optional keys on `envs` and
`profiles`. No existing key changes, so there is no migration; the schema stays strict and T1.1 extends it.

The **effective configuration** is the repo file intersected with the trust store (ADR 0025):

| Value | Anchor (trust store) | Repo value may |
|---|---|---|
| env origin and `class` | `envs`, `productionOrigins` | only match the store; mismatch or unknown env = refuse |
| `system1.allowedEnvs` | store list | only remove entries |
| `system1.baseUrl`, `allowedHosts`, `apiKeyEnv` | store (exact host plus port; names) | only choose among the allowed |
| login origins, env variable names for secrets | `profiles`, `profiles.<name>.envVars` | only narrow |
| `scope.allow`, `scope.deny`, budgets, extra destructive words | repo | narrow the built-in ceiling: shorter lists of allow, longer deny, smaller budgets |
| anything that would loosen a built-in default | store or an out-of-repo flag | nothing; a loosening value in the repo is ignored with a warning |

Merge ownership: **T1.1** owns the schema extension and the effective-config function (it reads the store
through the API of the trust-store task); **T5.1** consumes `system1` settings from it and does not touch the
schema. `system1.allowedHosts` lives only in the store.

**Per-key matrix.** Every repo key has a narrowing-only meaning and a test (T1.1 acceptance requires the
whole matrix as tests, each proving that a loosening value is ignored with a warning):

| Repo key | Narrowing-only meaning | Test that a loosening is ignored |
|---|---|---|
| `envs.<n>.baseUrl`, `loginUrl` | Must equal the store's origin for that name | A PR changes `baseUrl` to another origin: run refused |
| `defaultEnv` | Must equal the `defaultEnv` the owner recorded for the project in the store (section 5, "Change of `defaultEnv`"); never a `production` env | A PR changes `defaultEnv` to `shared`: ignored with a warning, the store value is used |
| `envs.<n>.vars` | Values only; never origins or secrets | A var holding a URL is not used as an origin |
| `profiles.<n>.locale` | Cosmetic | none needed |
| `system1.allowedEnvs` | Removes entries of the store list | A PR adds an env: ignored |
| `system1.baseUrl`, `apiKeyEnv` | Must be inside the store's hosts and names | A PR points at another host: refused |
| `system1.confidenceThreshold` | May only be raised | A lower value is ignored |
| `target.scope.visit`, `target.scope.call` | Intersected with the store's `visitOrigins` and `callOrigins` and with the built-in default | A wider origin is dropped |
| `target.scope.allow` | A subset of the built-in `visit` ceiling (the env's origin with `/**`); narrows only; matched case-sensitively and never overrides `deny` | An `allow` naming another origin or a wider path is dropped with a warning; an `allow` entry that a `deny` also matches is denied |
| `target.scope.deny` | Added to the built-in deny list; never removes | Removing a built-in deny is impossible |
| `target.budgets.*` | Min with the built-in ceiling | A bigger budget is capped |
| `target.destructiveWords` | Added to the core word list | A repo cannot remove a word |
| `target.profiles.<n>.login` | Selectors and recipe only; origins and secrets from the store | A login origin in the repo is ignored |
| `testIdAttribute`, timeouts, `maxSteps`, `runsRetention` | Numbers are min-ed with a built-in ceiling; `testIdAttribute` must match `^[A-Za-z][A-Za-z0-9_-]*$` | A larger number is capped; a pattern-breaking name is refused |
| `flowsDir` and every other repo-settable path (section 1a) | **Containment**, not a ceiling, by root kind: project-relative and strictly inside the project root, or a registered flows root by name, or the legacy `..` form only for `flowsDir` and only into a registered root; no symlink component; never the store, the owner-key directory, a `sessionDir` or a parent of one | A symlinked `flowsDir`, `../..` outside a registered root, an absolute path, and a path that contains the store are each refused (tests in 1a) |
| `snapshotIgnore` | Hides elements from the model's snapshot only; **the guard's own view of the page ignores it**, so it cannot hide a destructive control | A destructive control in `snapshotIgnore` is still caught |

The **built-in ceiling for scope** is: `visit` is the origin of the env's `baseUrl` with path `/**`;
`call` is the same origin plus the store's `callOrigins`; `deny` starts with logout, account deletion and
the destructive path tokens. A repo `allow` can only be a subset of that.

### 1a. Repo-settable paths: containment

"Capped" has no meaning for a path: a path is either inside the place it may name or it is not. A repo value
that becomes a filesystem path, directly or after template expansion, is a **path key**. The path keys, from
`packages/core/src/config.ts` and `flow/schema.ts` as of this ADR:

| Path key | Where it comes from | Used for |
|---|---|---|
| `flowsDir` | `ConfigSchema`, the only free path key of the config file | Flow files, and the root of everything below |
| `runsPath` | Derived: `<flowsPath>/.runs` | Evidence and `run.json` |
| `storageStatePath` | Derived: `<flowsPath>/.auth/<env>/<profile>.json` | Legacy in-repo sessions; refused once a store exists (section 4) |
| `<env>`, `<profile>`, `<flow>` names | `NAME_PATTERN` keys of `envs`, `profiles`, flow files | Path components of the keys above |
| `upload.file` | Flow step (`flow/schema.ts`), also after `{{...}}` expansion | Read by flowctl and handed to the browser as bytes |
| Files a hook names | Flow `setup`/`teardown` | Read to compute the closure (ADR 0021 amendment section 2) |

The flow schema has `setup` and `teardown` hooks and no sub-flow construct, so there is no sub-flow path key; if a
construct that includes another flow file is added, it joins this table in the same change. Keys added later (an
`observe` output directory, a repo `target:` path) join this table in the same change, and a schema test fails
when a string-valued key of `ConfigSchema` is not classified as a path key or a non-path key. The store's own
paths (`sessionDir`, `roots`) are not repo-settable and are outside this rule.

**Two kinds of root.** The **project root** is the directory of `flowctl.config.yaml`, identified by the store's
`projects` entry (ADR 0025 section 1). A **flows root** is a store `roots` entry of purpose `flows`
(ADR 0025 section 2), with a `name`, an absolute realpath and the root-commit identity of the repository that
holds it. The rules differ by root kind because "strictly inside" is wrong for a root that a key may name as a
whole.

**Rules.** One function in core's lowest layer (today `core/src/safe-fs.ts`) implements them; `flowsDir` is
checked when the effective configuration is built (T1.1), `upload.file` before the step runs (T1.2), session
and evidence paths where they are opened (T1.4, T1.8). T1.2 and T1.4 do not ship without it.

1. **Lexical form, all keys.** No NUL, no backslash, no leading `~`, not absolute, and none of the Windows
   forms: a drive letter, a UNC or `\\?\` prefix, a `:` inside a component (alternate data stream), a
   component ending in a dot or a space. This is checked before any file-system call. **Guarded actions are
   refused on Windows** (`platform_unsupported`; ADR 0025 section 1), so these forms are refused twice.
2. **Project form** (every key except the `flowsDir` forms 3 and 4): relative, no `..` component, and
   `realpath(path)` lies **strictly inside** `realpath(project root)`: not equal to it.
3. **Registered-flows-root form** (for `flowsDir` only): `root:<name>` or `root:<name>/<relative subpath>`,
   where `<name>` is the name of a flows root the store registers and the subpath follows rule 1 and has no
   `..`. `realpath` must equal the root or lie inside it; **equal to the root is allowed for this form only**.
   The root's recorded identity must match the repository at that path (`root_not_trusted` otherwise). This
   keeps ADR 0013's cross-repo layout working: the repo can name such a directory only if the owner registered it
   on this machine.
4. **Legacy `..` form** (for `flowsDir` only, ADR 0013's `../qa-tests/flows`): **`flowsDir` is the only
   key that may start with `..`.** It is resolved against the project root, and its realpath must equal or lie
   inside a registered flows root (then rule 3's identity check applies); anything else is refused.
5. **Keys under a flows root** (`runsPath`, `storageStatePath`, `upload.file`): relative, no `..`,
   `realpath` strictly inside `realpath(flows root)`. `upload.file` additionally must lie inside
   `<flows root>/fixtures/` (a fixed name; there is no config key for it), be a regular file, have **no component that starts
   with a dot** (no dotfile, no dot-directory), none named `.auth` or `.runs`, and neither be a registered
   `sessionDir` nor lie inside one.
6. **No `.git`.** No component may equal `.git` after Unicode case-folding and after both NFC and NFD
   normalisation (`.GIT`, `.Git` and composed or decomposed lookalikes are the same name on common file
   systems).
7. **No symlink.** Every existing component from the root down is `lstat`-ed; a symlink (or Windows junction)
   anywhere in the chain is refused. A component that does not exist yet is created by flowctl one directory at
   a time (as `ensureDirInside` does today); **on `EEXIST` it is `lstat`-ed again** and refused if it is now a
   symlink or not a directory.
8. **Never the store, the owner key or a session directory.** The resolved path must not be, be inside, or be a
   **parent of**: the store directory, the owner-key directory, or any registered `sessionDir` (compared by
   `realpath`). A `flowsDir` that widens to `~` or `~/.config` therefore fails even if the project root were a
   home directory. `trust add root` refuses the passwd home, its ancestors and any directory containing a
   credential directory (ADR 0025 section 2, `roots`).
9. **Files opened under a path key** use `O_NOFOLLOW`, then `fstat`: a regular file, **link count 1 (the
   refusal of a hard link is intended: the second name may lie outside the root)**, and the descriptor's device
   and inode match the path's `lstat` (the check ADR 0020 section d applies to contracts).
10. **Uploads.** flowctl opens the upload file itself under rule 9 with a size cap (default 10 MiB), re-checks
    the opened descriptor's own path against the root (`F_GETPATH` on macOS, `/proc/self/fd/<n>` on Linux),
    and passes `{ name, mimeType, buffer }` to `setInputFiles`. **A path is never handed to the browser**, so a
    swap between the check and Playwright's own open cannot redirect the read.
11. **Uploads and stored entries.** A flow covered by a `destructiveConfirm` entry (section 5) uses a literal
    `upload.file`, with no `{{...}}`, **or** the entry binds the expanded value (it is in `files` of the
    confirmation digest). An `upload.file` that depends on a run-time input, an `env:` input or a secret makes
    the flow unconfirmable. Read-only production replay refuses any `upload` step (section 2a).
12. **When.** At build of the effective configuration **and again at each open**, because a link can appear
    after load. `upload.file` is judged after template expansion.
13. **Failure mode.** A path key that fails is **refused** (`ConfigError`, kind `path_not_contained`, naming the
    key and the rule, never the file's content). It is not ignored-with-a-warning like a loosening value: a
    silent fallback to the default would run a different set of flows than the author meant.
14. **The effective flows directory must be a registered flows root.** Whatever form `flowsDir` took (rules 2
    to 4), its final `realpath` must **equal or lie inside** the flows root the store's `projects` entry
    names for this project (ADR 0025 section 2, `projects` and `roots`, which `trust init` fills in). Otherwise
    the run ends `root_not_trusted`. This closes the project form: a repo `flowsDir: some/dir` is honoured
    only if the owner registered that directory (or a parent of it) as the project's flows root.

*Tests (T1.1, T1.2):* `flowsDir` as a symlink; a symlinked intermediate directory; `..` under the project form;
an absolute path; `flowsDir: .`; a `flowsDir` whose parent holds the store, the owner-key directory or a
`sessionDir`; `root:<name>` equal to the root passing and the same through the project form failing; an
unregistered `..` target failing; a registered root whose repository identity changed failing; an `upload.file`
of `../../.ssh/id_rsa`, of a template that expands to it, of `fixtures/.env`, of `fixtures/.AUTH/x` and of
`fixtures/.GIT/config`; a hard link to a file outside the root; an upload whose path is swapped for a symlink
after the check (the browser receives the bytes of the first file); a directory created between `lstat` and
`mkdir` (`EEXIST` then symlink) refused.

*Alternatives considered:* hard containment inside the project root only (closes the same hole, but breaks
ADR 0013's cross-repo layout and forces QA's flows into the app repo); a path denylist such as `.ssh` and
`/etc` (a pattern list that always misses one). The registered-root form fixes the boundary by owner action,
as every other anchor in ADR 0025 does. ADR 0013 carries a pointer to this section.

**Owner decision:** keep ADR 0013's cross-repo layout through a store-registered flows root (recommended; written
above), or supersede 0013 and contain `flowsDir` inside the project root with no registration.

### 2. Production and environments

- An env named in the repo is honoured only if the store has the same name, origin and class; otherwise the
  run ends `error: env_not_trusted`.
- `productionOrigins` (store) are checked on **every redirect hop and every request** at the route layer.
  An origin in that list is `production` whatever the repo labels it, so renaming an env or changing its
  `baseUrl` in a pull request cannot skip the guard: the run is still blocked.
- **A production entry covers every scheme and port of its host.** Classification uses the normaliser of
  section 3 rule 2 (lowercase, trailing dot, IDN and userinfo normalised) on the host alone, so `http://app.example`,
  `https://app.example:8443` and `wss://app.example` are production when `https://app.example` is listed. Only the
  exact listed origin (`https`, default port) can carry an `allowReadOnlyReplay` entry; any request to another
  scheme or port of the host is blocked.
- A production env's `callOrigins` are automatically production origins (ADR 0025 section 2, `envs`) and each
  needs its own entry to be used.
- `guards.production: block` is the default and is not repo-loosenable. The one exception, read-only
  replay, needs the store entry described in section 2a.
- `system1.allowedEnvs` is the one data-policy list of ADR 0005.
- **Amendment of ADR 0005 (pointer added there).** ADR 0005 lets replay without heal run in any env. This
  ADR keeps that for production only in the read-only form of section 2a. Exploration, heal and every write
  on production stay blocked. Elsewhere replay without heal is unchanged. Justification: it preserves what
  ADR 0005 promised (recorded flows can verify production without a model) without letting a pull request
  turn a replay into a write.

### 2a. Read-only replay on production

The store entry for a production origin carries `allowReadOnlyReplay`. **This is the one schema** (ADR 0025
section 2 points here and does not repeat the grammar):

```
productionOrigins:
  "https://app.example":
    allowReadOnlyReplay:
      profiles:   [<profile>, ...]                 # the only profiles that may run read-only
      sessions:   { <profile>: <file name> }       # a plain file name under sessionDir, no separator
      templates:  [{ class, path, query, headers? }, ...]
      assetPaths: [</assets/>, ...]                # literal path prefixes for static subresources
      assetQuery: [v, ver, hash]                   # query names allowed on those subresources
      sessionMaxAge: 24h
      expires: <YYYY-MM-DD>
```

`class` is one of `document`, `xhr`, `eventsource`, `graphql`. **The repo cannot add or change a field**: a
template, a profile, a session, a path, a query name or a header comes only from the store, written by
`flowctl trust add readonly-replay` with an owner-key signature (ADR 0025 section 3). The entry is valid until
**`min(session createdAt + sessionMaxAge, expires)`**; past it the entry is treated as absent
(`readonly_replay_not_trusted`; `profile_expired` for the session). It is an **allowlist**, and every part of a
request is judged against it, not against a denylist of bad names.

**Request rules.** The route layer aborts a request unless **all** of these hold. An abort ends the run
`error: prod_request_blocked`, reporting **only** `method origin class sha256(path)[:8]` (the first 8 hex
characters of the hash of the raw path; no path text, no query, no ids); it is never silently dropped.

1. **Method** is exactly `GET`, with no request body. `HEAD`, `OPTIONS` and everything else are aborted. A
   CORS preflight is issued by the browser and cannot be intercepted by Playwright; the guard judges the real
   request that follows. That a server must not change state on `OPTIONS` is outside what flowctl can check
   and is a named limit. Prefetch and prerender are disabled (launch flags and an init script that removes
   speculation rules), because a request the route layer never sees cannot be judged.
2. **Origin** equals the entry's origin (scheme, host, port; no userinfo; `https`).
3. **Path** is matched by the steps and grammar below, **and the request's resource type maps to the
   template's `class`**: `document` (a navigation) to `document`; `fetch` or `xhr` to `xhr`, or to `graphql` when
   the template says so; `eventsource` to `eventsource`. A request whose resource type does not map to the
   matching template's class is aborted, and a resource type with no mapping (`websocket`, `ping`, `other`,
   `texttrack`, `prefetch`) is aborted unless rule 6 admits it as a subresource.
4. **Query** is matched by the template's `query` rule (below). A template with no `query` rule allows **no**
   query string. This covers `?_method=DELETE`, `?action=delete`, `?export=1` and any `?query=mutation...`
   without naming them. Pinning the whole query string to the recorded one was rejected: dates and page
   numbers change between runs.
5. **Headers** are only these exact names: `accept`, `accept-encoding`, `accept-language`, `cache-control`,
   `connection`, `cookie`, `dnt`, `host`, `if-modified-since`, `if-none-match`, `origin`, `pragma`, `priority`,
   `range`, `referer`, `upgrade-insecure-requests`, `user-agent`; the wildcard families **`sec-fetch-*` and
   `sec-ch-ua*` only**; plus the names the template lists in `headers` (for example `x-requested-with`,
   `last-event-id`; each must match `^[a-z0-9-]+$` and `trust add` refuses a name containing `method` or
   `override`). **Any other header aborts the request**, so `X-HTTP-Method-Override` and names nobody has
   invented yet are blocked by the same rule.
6. **Subresources** (`image`, `stylesheet`, `font`, `media`, `script`, `manifest`) need no template **only if**
   the path starts with one of the entry's literal `assetPaths` prefixes, ends in one of `.js .css .png .jpg
   .jpeg .gif .svg .webp .avif .ico .woff .woff2 .ttf .otf`, the request is `GET`, and its query names are all
   in `assetQuery` (values pass the same query steps). Everything else needs a template.
7. **A template match never overrides a deny.** After a template matches, the `deny` list of section 3 and the
   destructive tokens of section 5 (request layer) are still applied, case-folded; a hit aborts. `trust add
   readonly-replay` refuses a template whose literal segments contain a destructive token or match `deny`.

**Template grammar.** A template path is literal segments plus typed single-segment placeholders `{int}`,
`{uuid}`, `{slug}`. A template must contain **at least one literal segment, and its first and last segments must
be literal** (it may not begin or end with a bare placeholder); a placeholder is the whole segment. There is no
`*`, no `**`, no regex and no optional segment; a template containing one is invalid and the entry is ignored
with `trust_entry_invalid`.

**Anchored value types** (each regex is matched against the whole string; digits are ASCII `0-9`):

| Type | Rule |
|---|---|
| `int` | `^(0\|[1-9][0-9]{0,17})$` |
| `date` | `^[0-9]{4}-[0-9]{2}-[0-9]{2}$` and a real calendar date |
| `uuid` | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$` (lowercase only) |
| `slug` | `^[a-z0-9-]{1,64}$` |
| `enum[a\|b]` | exactly one of the members; every member matches `^[A-Za-z0-9_.-]+$` (no escapes exist; an entry with another character is invalid) |
| `literal:<text>` | exactly `<text>`, which matches `^[A-Za-z0-9_.-]+$` (no escapes) |
| `sha256[h1\|h2]` | one of the listed 64-character lowercase hex values (persisted GraphQL query hash) |

**Path steps.** A path is judged in this order, so every decode, case and dot-segment trick lands on the same
refusal: (a0) on the **raw** path, before any decoding, refuse `%2f`, `%5c` and `%00` and **`%25` followed by
anything**, in any letter case (so a second decode can never change the result, and none is performed); (a)
decode **once**; (a2) the raw path must equal its **canonical re-encoding** (unreserved characters
`A-Za-z0-9-._~` as they are, every other byte as `%XX` with upper-case hex, segments joined by `/`): lower-case
hex, an unneeded escape (`%41`, and `%2e`, which encodes an unreserved `.`) and a raw `+` are refused, and
`%2e%2e` is additionally caught by (c) after decoding; (b) refuse NUL, control characters, `\` and any `;` (unlike `deny` matching, an
allowlist **does not strip** `;params`: the server may route on them); a decoded segment must be valid UTF-8 in
NFC; (c) refuse a `.` or `..` segment and an empty segment (`//`); (d) match **case-sensitively** and exactly,
including a trailing `/`. The raw path is at most 2048 bytes. Case-sensitive matching is stricter than a
case-folded one for an allowlist; `deny` stays case-folded (section 3).

**Query steps.** The raw query is split on `&`; each pair is `name=value` with a non-empty name. Refuse: an
empty pair, a pair without `=`, a **raw `+`**, a repeated name, array syntax (`a[]=`, which is not in the list),
a name not in the template's `query` list, and a total length over 2 KiB. Decode each name and value **once**;
refuse if the decoded text still contains `%`, `;`, NUL, a control character or `+` (fixed-point-then-refuse:
nothing is decoded a second time). The **raw query must equal its canonical re-serialisation** (same pairs in
the order sent, each re-encoded as in the path steps). Each value must then pass its declared type.

**Other request classes.** Each is blocked or covered by a test that documents the limit:

- **WebSocket:** blocked (`routeWebSocket` refuses the connection). Allowing receive-only was rejected: most
  protocols need an outbound subscribe frame, so outbound frames cannot be dropped without breaking the
  protocol, and an allowed outbound frame is a write channel.
- **EventSource:** a `GET` and it must match a template with `class: eventsource`; otherwise blocked.
- **GraphQL over GET:** an inline document (`query=` parameter) is always aborted. A GraphQL endpoint may be
  listed only as `class: graphql` with a `query` rule whose `extensions` value has the type `sha256[...]`
  from an exact list. POST GraphQL is blocked as any non-GET.
- **`sendBeacon`, form POST, `ping` attributes, uploads, downloads that need a POST:** non-GET, blocked.
- **Service workers** are blocked (section 3). **WebRTC and WebTransport** cannot be intercepted by
  Playwright; they are disabled by launch flags and an init script, and a test documents that this is best
  effort, as in section 3 rule 6.
- **A request class flowctl does not know** (a browser feature added after this ADR) is not judged by any rule
  above. The only containment against it is the account: **run read-only replay with a viewer account that
  cannot write in the application**. flowctl cannot verify the role; the owner attests it (below).

**Who may run read-only.** Only a profile listed in `profiles`, which the owner registers with `flowctl trust
add readonly-replay`. A flow that switches profile with `as:` to an unlisted one is refused before it starts. A
flow is also refused before it starts if it has hooks, an `upload` step, **any step whose kind is not in this
closed list: `goto`, `click`, `fill`, `press`, `select`, `expect*`, `wait*`** (so `screenshot`, `download`,
`pdf` and any capture-to-output step are refused), or **provenance state other than `verified` or
`hand-written`** (ADR 0020 section h): an unreviewed flow does not get to read production.

**How the production session is created.** Replay never logs in on production, so a login POST is never needed.
The session is created **by the owner, interactively**: `flowctl login <profile> --env production` on a TTY,
refused over MCP and in any non-interactive context, for a listed profile only, with tracing off. The
owner logs in by hand in the browser (ADR 0011); flowctl filters the cookies as in section 4 and writes the
file named in `sessions[<profile>]` to the store's `sessionDir`, mode 0600, with a **`createdAt` field written
inside the file** by flowctl. `login --auto` (T1.6) is refused on a `production` env. A CI runner receives the
session file in its provisioned store (ADR 0025 section 3). **Session age is judged by `createdAt` inside the
file, never by the file's modification time** (a copy or a touch resets mtime); a session older than
`sessionMaxAge` is refused with `profile_expired`. Writing the session is the one production interaction that
is not read-only; it is a human action, not part of a replay.

**Evidence from production.** The redaction rule is ADR 0005's amendment; the mechanism is here. It is keyed
on origins, not on the env name or a flag, and **the mode is decided before the first byte is written or
sent**, from the union of the env's `baseUrl`, its `visit` and `call` origins and the profile's login origins
(all from the store). If any of them is a production origin the whole run is `evidence:
redacted-production` from its first step. Redaction never turns off during a run: a later redirect to a
production origin keeps or switches it on, and nothing switches it off. Such a run:

- writes **no trace, no screenshot, no video and no DOM snapshot** and stores **no response bodies**;
- records network lines as method, matched template (query and ids as placeholders), status, size and timing,
  and records an assertion's actual text as its length plus pass or fail (`[redacted:production]`);
- **replaces every error string** (a thrown error, a locator timeout, a failed assertion) with a fixed code and
  placeholders, so no page text, URL id or response fragment travels in `run.json`, the summary, stdout, stderr
  or the MCP result;
- refuses before it starts any flow with a `screenshot`, `download` or `pdf` step or a step that captures into
  the output (listed above).

T1.8 implements it in the evidence writer. *Test:* seed a production-class origin whose responses and pages
contain a marker string, including in an error path; after a run, the marker is in no file under the run
directory (including the contents of any archive), **in no temporary directory the run used, in stdout or
stderr, and in no MCP result**; the same holds when the run touches the production origin only through a
`callOrigin` or a redirect.

**Verdict oracle (limit).** Even with redacted evidence, a pass or fail is one bit about page content, and a
flow author can write assertions that probe for a value (`text contains X`). Read-only replay therefore does not
make production data unreadable to whoever can edit the flow; it keeps the data off disk and out of artifacts.
ADR 0005's amendment states the same limit. The flows allowed to run there are the reviewed ones (provenance
rule above).

**Failure mode.** Everything unmatched is blocked, a blocked request fails the run loudly, and an entry that
does not parse is ignored (never partially applied). *Alternatives considered:* a boolean, a denylist of write
paths, and a stripping layer that removes override headers and sends the rest (changes the request instead of
refusing it).

**Owner decision:** whether screenshots of production pages may ever be kept. Recommended default: no, as above.
Option: an `evidence.screenshots: true` store key per production env, masked by the same text redaction.

### 3. Scope: may visit versus may call

Two sets, both subsets of what the store trusts for the env:

- **`visit`**: origins and paths a page navigation (and popups, frames, history changes) may reach;
- **`call`**: origins the page's own requests may reach (fetch, XHR, form actions, subresources). A
  front-end origin and its API origin are usually different; `call` lists the API without letting the
  crawler navigate there.

One function `inScope(url, kind)` is implemented in `core/src/browser/scope.ts` (layer `browser`, below `run`) and **injected** into `RunSession` as an option, so the executor, the crawler and the run layer call the same function without `browser` importing `run`. Task T1.2 owns `core/src/browser/scope*` and the injection point in `core/src/run/`. It runs before every request and on every redirect hop.
A refusal is `RunError` kind `scope_violation`. The rules:

1. Only `http` and `https`. `javascript:`, `data:`, `blob:`, `file:` are refused. `http` only for loopback
   or RFC1918 hosts, or with an explicit flag; credentials are never typed on `http`.
2. Origin compared after parsing on `scheme + host + port` with default ports, trailing dots, IDN and
   userinfo normalised (`https://app@evil.test` has host `evil.test`); a subdomain-suffix host fails.
3. Path, before matching: percent-decode **to a fixed point** (at most five rounds; a string still changing
   at the fifth round is refused), resolve `.` and `..`, strip `;params`. `deny` is matched case-folded,
   always; `allow` is case-sensitive, always. Neither is a repo setting. **`deny` wins** over `allow`.
4. `//host/path` is resolved against the current page, then judged by its real host.
5. **Hash routes.** `#/admin` is not sent to the server, but a single-page app treats it as a path. `allow`
   and `deny` apply to a hash path starting `#/` **always**; there is no switch to turn this off, so it
   cannot weaken.
6. **Request classes, each enforced or covered by a test that documents the limit:** document navigations,
   subresources, fetch and XHR, form actions, `sendBeacon`, EventSource (route layer, enforced);
   WebSocket (Playwright `routeWebSocket`, enforced); **service workers are blocked**
   (`serviceWorkers: 'block'` on the context, enforced); downloads are refused unless the flow declares
   them, and uploads only from regular files under `<flows root>/fixtures/`, opened by flowctl and passed to
   the browser as bytes, judged by section 1a after template expansion; WebRTC is disabled by launch flags and an init
   script that removes `RTCPeerConnection`, and a test documents that this is best effort, so no
   WebRTC call is part of a verdict.
7. `history.pushState`, `framenavigated`, `target=_blank`, `window.open`, `opener` pages and iframes are
   checked on their first URL; an out-of-scope page is closed, an out-of-scope frame is not entered.

This supersedes the path-only check of issue #40. The crawler and the executor share the function.

### 4. Credentials and sessions

- A credential is a reference (`{ env: NAME }` now; `op://`, `bw:`, `totp:` later, T1.7), never a value.
  Names must be in the store's `profiles.<name>.envVars` for the profile; there is no implicit allowance, and the **kind** of each variable (`secret` or `username`) is bound there, never in a flow.
- The login URL passes `inScope`. A credential is typed only when the **frame that owns the target element**
  has an origin in the profile's trusted login origins (store) **at the moment of typing**, after every
  redirect hop, and is `https` or loopback. Cross-origin iframes are refused. The check and the typing are
  one browser-side step: the page-side code re-reads `location.origin`, and a navigation event between the
  check and the keystroke aborts the step, clears the field and fails the login, so a redirect cannot swap
  the page under the cursor.
- **Field roles.** An env input is typed only into a field of the role its kind allows: a password
  reference only into a password-type field (`type=password`); the env username only into a field with the
  username role (`autocomplete=username`, or the text or email field of the form that also holds the
  password field). Any other env input must name a role in the flow and the store allowlist. The username
  is still treated as a secret for masking and redaction, but it is not a password and may go in the
  username field.
- **Resolvers** (`op://`, `bw:`, `totp:`): argv-only, no shell, `--` before references and a rejected
  leading `-`, a **pinned absolute binary path** from the store (never from cwd, the worktree or
  `node_modules/.bin`), a minimal child environment (no LLM key; only the variables the CLI needs), a
  vault or item allowlist from the store, a timeout, strict syntax validation, child output never in errors.
  A TOTP seed comes only from a resolver reference, never inline; the seed and every code are secrets.
- **Redaction.** Session tokens are secrets: `Set-Cookie`, `Authorization`, bearer tokens in responses, in
  traces, network logs and `run.json`. **Tracing is paused during login** (started after the session is
  established). Tests cover plain, base64, URL-encoded, JSON-escaped, HTML-escaped, hex, prefix and suffix
  forms, token headers in network logs, and screenshots with `type=password` masked.
- **Sessions** are filtered to the profile's origins when written and when read: a host-only cookie matches
  the exact host; a `Domain` cookie matches by RFC 6265 domain-match, never a naive suffix;
  `localStorage` and `sessionStorage` by exact origin. Anything else is dropped with a warning that names
  the domain, not the value. Files are created with mode 0600 at creation (open mode, not chmod), in the
  trust store's `sessionDir`, **outside the repo**. The old in-repo path `.flows/.auth/` is legacy and
  dev-only: it is refused as soon as a trust store exists, and the `.gitignore` entries for it remain as a
  belt-and-braces measure. The manual `flowctl login` of ADR 0011 writes to the same `sessionDir`, so it moves
too (ADR 0011 gets an amendment pointer; the owner is T1.4, which owns `login.ts` and `run/profiles.ts`).
On Windows, where modes cannot be verified, saving sessions is refused.

### 5. Destructive actions

- **Matcher.** A control is destructive when its accessible name, `data-testid` or `href` contains a word
  from the core-owned word list. Text is NFC-normalised and **tokenised on case change, `_`, `-`, `/` and
  whitespace** before the whole-word comparison, so "Resend" does not match "send" and `DeleteAll` does
  match "delete". The list is data in core and includes Vietnamese words; extra words may come from the
  repo (narrowing only). An unnamed (icon-only) control in a non-GET form is destructive until labelled.
- **Request layer.** The DOM heuristic is the second line. On `shared` and `production` classes the
  request layer denies by method and path: non-GET requests, and GET paths that contain destructive tokens
  (a side-effecting GET such as `/items/12/delete`), unless the store has a matching entry. **On `production`
  no entry can exist** (below): everything non-GET is blocked, as section 2a says.
- **Confirm.** The UI-level guard may use the control label. A **stored confirmation** is keyed on the
  **exact URL template, method, env and the confirmation digest of the flow** (below), and it authorises a
  request only for **a record whose id was created by this run** (the run ledger, below). There is no `QA-`
  row predicate: `QA-` constrains what a flow may **create**, and it never **authorises** mutating an
  existing record; a record not created in this run cannot be mutated on the strength of a name. A label alone
  never authorises a request. Non-interactive callers (CI, pipes) without an entry are blocked; over MCP no
  caller can answer, so without an entry the action is refused. A TTY is friction, not proof of a human (ADR
  0025 section 6).
- **No wildcards in an entry.** This holds for every entry, and matters most for one provisioned in a `ci`
  store, where nobody is at a terminal. The digest is the full 64-character sha256: no prefix, no `*`. The URL
  template uses the closed grammar of section 2a (literal segments and typed single-segment placeholders;
  no `*`, `**`, regex or optional segment), and method and env are exact. An entry that breaks the grammar,
  has an unknown field or names a `production` env is ignored with `trust_entry_invalid`, so a `*` hash that
  would match whatever a pull request changes the flow into cannot exist. Cost: every edit of a flow, of a
  file in its closure or of a variable it references needs the entry provisioned again. *Alternative
  considered:* a wildcard hash guarded by CODEOWNERS on the flows directory; rejected, since CODEOWNERS is
  not an anchor (ADR 0025).
- **Closure and confirmation digest.** The closure of a flow is: the flow file, every `upload.file` (a
  literal, after section 1a), and the hook closure of `setup` and `teardown`. **The hook closure is defined
  once, in [ADR 0021](0021-hook-consent.md) amendment section 2** (an allowlist of builtins, a short utility
  list and shell scripts); this ADR keeps no word list, depth or file limit of its own: a hook that fails that
  test is `uncovered`. The confirmation digest is the sha256 of this
  canonical JSON (keys sorted, UTF-8, no whitespace):

  ```
  {"v":1,"purpose":"confirm","flow":"<sha256 of the flow file>",
   "files":[{"path":"<relative to the flows root>","sha256":"..."}],
   "hooks":{"setup":<closure of setup>,"teardown":<closure of teardown>},
   "vars":{"<name>":"<effective value>"}}
  ```

  `files` lists the `upload.file` targets; each `hooks` value is the closure function's output of ADR 0021
  (hook text, files with hashes, `uncovered` list). `vars` holds the **effective value** of every `vars` entry
  and `{{...}}` expansion the flow references (decision D9: included, because a value substituted into a
  destructive URL or body changes what is sent). The hook-consent digest of ADR 0021 has `"purpose":"hook"` and
  shares with this one **only the closure function and the file-hashing function**, so one digest can never
  stand in for the other (the third digest, `purpose: classify`, is for `handWritten`, ADR 0021). **For a destructive confirmation an `uncovered` hook is refused**: `trust add
  destructive` does not write the entry and a stored entry is ignored (`trust_entry_invalid`). A flow is
  **unconfirmable** (no entry can be written for it) when an `upload.file` or any value reaching a request
  covered by an entry comes from a run-time input, an `env:` input or a secret, because the digest cannot bind
  a value that is not known when the owner confirms. The files are read as ADR 0021 section 2.7 says (no
  symlink, link count 1, snapshot); a same-user write between check and use is a stated residual (ADR 0025
  section 6). An `uncovered` hook cannot be accepted for destructive confirmation even by an interactive owner;
  a hook that must run there moves into a script the closure covers. **For destructive confirmation the
  allowlist is narrower than ADR 0021's:** a hook (and every script it calls) may use only the builtins of ADR
  0021 section 2.2(a) and `mkdir`, `touch`, `cat`, `sleep`; a hook that uses `curl`, `psql`, `rm`, `mv` or `cp`
  is `uncovered` for this purpose, because those can reach shared data or other hosts. For hook consent alone,
  ADR 0021 lets an interactive owner accept an `uncovered` hook in a store that is not marked `ci`.
- **The `destructiveConfirm` entry (schema).** Entries live in the store (ADR 0025 section 2) and are written
  only by `flowctl trust add destructive` with an owner-key signature, and removed by `flowctl trust revoke
  destructive <id>` (ADR 0025 section 3). Every field is required unless
  marked optional; an unknown field makes the entry invalid.

  ```
  destructiveConfirm:
    - id: <NAME_PATTERN, unique>      # referenced by ledgerFrom
      env: <env name>                  # class shared or local; production => trust_entry_invalid
      origin: <exact origin>           # the entry applies to requests to this origin only
      expires: <YYYY-MM-DD>            # at most 90 days after the entry is written; then it is absent
      flow: <flow name>
      hash: <64 lowercase hex>         # the confirmation digest above; no prefix, no *
      kind: create | mutate | session  # there is no kind for GET
      method: POST | PATCH | PUT | DELETE
      template: </path/{int}/...>      # section 2a grammar; {slug} is invalid here
      contentType: json | urlencoded   # optional for DELETE with no body
      bodyKeys: [<full JSON path>]     # closed list; required for create, may be empty for DELETE
      queryKeys: [<name>]              # closed list; default empty
      headers: [<name>]                # optional; extra to the exact baseline of section 2a
      # create only
      idFrom: body:<JSON path> | header:Location
      nameField: <full JSON path>      # the field the QA prefix is checked on
      prefix: QA-                      # default QA-
      naturalKeys: [<full JSON path>]  # required, non-empty; every listed field must start with prefix
      conflictStatus: [409, 422]       # the owner attests the endpoint answers one of these
                                       # when the natural key exists and never updates the row
      cleanup: { method, template, verify: { template } }   # or cleanup: step, with verify
      # mutate only
      ledgerFrom: <id of the create entry whose ids this entry may touch>
      idPositions: [path | body:<JSON path> | query:<name> | body:<JSON path>[]]   # non-empty
      # session only: method POST, template literal (no placeholder), no ledger, no ids
  ```

  *Kinds.* **Prefix rule.** The `template` of a `mutate` entry, and the `cleanup` and `verify` templates of a
  `create` entry, must share the literal path prefix of the `create` entry named by `ledgerFrom` (every literal
  segment before the first placeholder is identical), so a `mutate` cannot be pointed at another resource
  collection. **Natural keys.** Every field in `naturalKeys` must start with `prefix`; when the 201 response
  echoes a natural-key field, its value must equal the one in the request, else the run ends `ledger_mismatch`
  and starts cleanup. `create` mints ledger ids. `mutate` changes or deletes a record the run created (`PATCH`, `PUT`,
  `DELETE`). `session` allows the login and logout endpoints of the app to be called by a flow on `shared`
  (a literal path, a closed list of body keys, no id): the owner attests that the endpoint creates or ends a
  session and nothing else. A `POST` that acts on a ledger id (`POST /orders/{id}/approve`) has **no entry
  kind and is blocked** on `shared`; such a flow cannot run unattended there (recommended default: leave it so;
  adding an `action` kind later needs its own ADR).
- **The run ledger: what "created by this run" means.** Each run keeps a ledger, in memory and as the
  **authoritative copy in the trust store**, `<store>/ledgers/<run id>.jsonl` (mode 0600, created with
  `O_EXCL`; each line carries the hash of the previous one, like `trust.log`), empty at start and never carried
  to another run. A copy under the run directory is a convenience only. Rules:
  1. **Keyed by (create-entry `id`, record id).** A `mutate` entry names `ledgerFrom` and authorises only ids
     that entry minted. An id minted by one create entry cannot be mutated through another entry's `mutate`.
  2. **When an id enters.** A request the run itself sent, matching a stored `create` entry (method `POST`,
     response 201, the id **absent from the whole request**: path, query, **every header including
     `idempotency-key`, `x-idempotency-key`, `x-request-id` and `x-correlation-id`**, and body), returns it at
     the place `idFrom` names. **It enters only if that id string has not appeared in any earlier response body or
     page text of this run** (the run keeps a set of every id-shaped token it has seen). An id read from page
     text, from a list or from the request never enters. Ids are compared as exact strings after
     canonicalisation (lowercase uuid, integer without leading zeros).
  3. **Natural-key conflicts.** The create entry declares `conflictStatus` (409 or 422): the owner attests that
     creating a row whose natural key exists fails with one of them instead of replacing it. A 201 that returns
     an id seen earlier in the run is not recorded and aborts the run `ledger_replay`.
  4. **Body discipline, create and mutate.** The body is parsed strictly: duplicate JSON keys at any depth,
     an absent or unsupported `Content-Type`, a BOM and non-UTF-8 bytes each block the request. Only
     `application/json` and `application/x-www-form-urlencoded` are accepted (no multipart, no other type). The
     body may contain only the full paths listed in `bodyKeys` (a `filter`, `where` or `all: true` key blocks
     it), the query only names in `queryKeys` (default none), the headers only the exact baseline of section 2a
     plus `headers`.
  5. **Fields that reference existing records** (a parent id, an owner id) must be a ledger id of the same
     run or a fixed literal the entry declares; a value taken from page text is blocked.
  6. **Every placeholder** in a destructive `template` is an id position bound to the ledger. `{slug}` is
     invalid in a destructive entry. The path must already be in canonical form (lowercase uuid, integer without
     leading zeros) and **is sent exactly as matched**; there is no second normalisation between the match and
     the wire.
  7. **A `mutate` request** names every position that carries an id in `idPositions` (`path`, `body:<path>`,
     `query:<name>`, `body:<path>[]` for an array). It is authorised only if the list is non-empty and **every**
     value at those positions is in the ledger for `ledgerFrom`. A bulk request is an explicit array of at most
     20 ledger ids; a bulk-by-filter request is never authorised.
  8. **Endpoints without an id** (`DELETE /items`, `POST /items/clear`, `PATCH /settings`, a reset) cannot be
     authorised by "created by this run": no entry kind exists for them on `shared`; on `local` they need no
     entry. An **upsert-on-create** endpoint (`PUT /items/{client-id}`, a `POST` keyed on a natural key that
     replaces a row) fails the `conflictStatus` attestation, so the ledger never accepts a client-chosen id
     and such a flow cannot run on `shared`. *Alternative considered:* an existence probe before the `PUT`;
     rejected because probe and write are not one atomic step.
  9. **Capacity and durability.** The ledger holds at most 500 ids; **an overflow aborts the run**
     (`ledger_overflow`) and starts cleanup. Each id is **appended and fsynced to the store ledger before the
     response is passed on to the page**, so a crash cannot lose an id that was created. A run on a `ci` store,
     whose store the job cannot write, writes its ledger to a `ledgers` directory named in the provisioned
     store and writable by the job user; that directory is the only part of a `ci` store the job writes.
  10. **Cleanup.** `flowctl cleanup <run id>` (guarded, ADR 0025 section 3) takes a run id that matches
      `NAME_PATTERN` (never a path), reads **only** `<store>/ledgers/<run id>.jsonl` after verifying its hash
      chain, and sends the create entry's `cleanup` requests for every id, so a crashed run can be cleaned
      afterwards. **"Confirmed
      deleted"** means: the cleanup request answered 2xx, 404 or 410, **and** the entry's `verify` request
      (a `GET` on the verify template with the id) answered 404 or 410. Otherwise the id is leftover.
- **What the owner sees when confirming.** `flowctl trust add destructive` (interactive only, nonce on
  `/dev/tty`, ADR 0025 section 3) applies the **display rules of ADR 0025 section 3** (built-in paging, escaped
  invisible characters, punycode, byte lengths, 256 KiB cap) and prints, in full: the env name, origin and
  class; the flow path and its whole text; the 64-character digest and every closure file with its own hash
  and content; the effective `vars`; for a changed flow, the line diff against the previously confirmed version
  **only when the diff base is a blob whose hash equals the stored per-file hash** in the earlier entry (found
  in the flows repository by hash), else the words "no previous version"; and **last**, in one fixed format
  per line (`kind method template idFrom|ledgerFrom bodyKeys queryKeys headers nameField prefix cleanup`), the
  exact entries it will write. **The entries are not typed and not read from the repo:** they are derived from a
  recorded run of the flow on a `local` env, and the owner reviews that recording (each request's method, URL
  and body keys) before the entries are offered. It refuses to write when the closure has an `uncovered`
  hook, the flow is unconfirmable, or the output is not a TTY. The screen cannot show that every destructive
  request has an entry; the request layer enforces that at run time.
- **Scope of the guard.** It covers the crawler, derived flows and the drive stage in every env class, and
  hand-written replay on `production`. On `shared` envs (where other people's data lives), a hand-written
  flow that declares its own destructive steps (a CRUD flow) runs when its confirmation digest has a stored
  confirmation: the owner confirms each flow version once, and unchanged flows then run unattended, so
  ADR 0008's model-free replay does not regress. **Hand-written CRUD flows on `shared` also need the
  `QA-` prefix and cleanup of the unattended rule below**; a confirmation does not waive them. On `local`,
  hand-written flows are not blocked. On `production` no confirmation exists: the read-only form of section 2a
  is the only way a flow runs there.
- **Unattended flows.** CRUD invariants, the T2.8 drive stage, the accuracy tier **and hand-written CRUD flows
  on `shared`** must delete and submit. They may do so **only** in non-production envs, with `QA-` prefixed
  inputs, a cleanup, and a `destructiveConfirm` entry in the store of the machine or CI runner. Without all
  four they stop. The `QA-` prefix is checked by the request layer on the create request's `nameField` named in
  the entry, not by the flow's own claim. At the end of the run, and in `flowctl cleanup <run>`, every ledger id
  must be **confirmed deleted** (rule 10); otherwise the result carries `cleanup_incomplete` with the leftover
  ids (verdict unchanged, ADR 0004; CI exits non-zero).
- **Change of `defaultEnv`.** `defaultEnv` decides where a command without `--env` runs, so editing it in a
  pull request moves unattended runs to another env. It is a **scope change**: the store records the
  project's `defaultEnv` (ADR 0025 section 2, `projects`), **typed by the owner at `trust init` and changed only
  by the owner-signed `flowctl trust add default-env`**. The repo value is honoured only if equal; otherwise it
  is ignored **with a warning on every command** and the stored value is used. A `production` env is never a
  default; a guarded action on it needs the env named explicitly. *Alternative considered:* default may name
  only a `local` env, which is stricter but breaks teams that default to staging.
  **Owner decision:** the recorded-default rule above (recommended) or the stricter local-only default.
- fixture-app gets destructive controls without text or `aria-label`, and a side-effecting GET, so the
  filters are tested where they are weakest (T2.6).

### 6. Budgets and transport

Pages, wall-clock time and cost per run are checked by the loop, not by the model. The wall-clock limit is
an **independent timer plus an `AbortSignal`** that aborts the browser work and the driver call; it does
not depend on the loop reaching its next iteration. Cost is computed by flowctl from token counts and a
configured price table; a driver that reports `costUsd` of 0 or nothing is not trusted, and unknown cost
counts as the maximum. The price table lives in the store (or is built in), and a repo may only
raise a price.

The driver and resolver transports ignore `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`, refuse
`NODE_TLS_REJECT_UNAUTHORIZED=0` and any custom CA, unless the store allows them for that host.

### 7. Flow-level `inputs: { env: NAME }` (issue #41)

**Decided by the owner on 2026-10-30 (T0.12): Option A.** Flows keep `inputs: { env: NAME }`. The allowlist
lives **in the trust store**, per profile and per project, with the exclusions and rules of ADR 0025
section 4. **Each user maintains it on their own machine** (`flowctl trust add`): the store holds variable
names and kinds only, never values, which stay in the user's own environment or secret manager. flowctl
keeps no central secret store, and a repo file cannot add a name. A **code owner** (T1.14) implements the
allowlist check in the trust-store work, so the decision cannot stay a text-only item. No new `env:` input
path is added before then (T0.13).

Option B, removing the input kind, was rejected: it would remove the documented way to pass a secret
(`.claude/rules/flows.md`) before its replacement, the profile resolvers of T1.7, exists, and it would break
any flow that uses it.

## Options considered

- **Anchors in `target.yaml`, with CODEOWNERS**: a branch the agent controls carries its own copy of the
  file. Rejected as the anchor (ADR 0025).
- **Path-only scope** (issue #40): the bug. **Scope in the prompt**: a model told to stay in scope will
  sometimes not.
- **A second config file next to `flowctl.config.yaml`**: two sources of truth and a merge nobody owns.
  Rejected; one file, new keys.
- **Credentials as values in a gitignored file**: leaks into evidence and screenshots. Rejected.

## Consequences

- **Easier:** one checkable statement of where the tool may go; a pull request that renames an env, adds
  an origin or loosens a guard changes nothing the machine trusts.
- **Harder:** every machine and CI runner needs a provisioned store; every request class needs a route
  rule or a documenting test; the destructive heuristic is never exact, so request-layer deny and confirm
  are the defaults; Playwright cannot intercept WebRTC, hence the best-effort rule and its test.
- **Revisit when:** multi-origin apps (a separate auth host) need per-origin session rules, the
  destructive list shows false negatives in the corpus (P6), or teams need a shared signed store.

## Amendment 2026-11-01: path containment, read-only production replay, confirmation binding

Accepted by the owner on 2026-11-02, as written and including the recommended default of each decision it marks; tasks T0.19, T0.21, T0.23 and T0.24 are closed. Security
review of PR #73 and the three independent reviews that followed it. The status stays `proposed`.

- **Section 1a (new): repo-settable paths are contained**, by root kind: project-relative and strictly inside
  the project root, a registered flows root by name (equal to the root allowed there only), or the legacy `..`
  form for `flowsDir` alone into a registered root. No symlink component, never the store, the owner-key
  directory or a `sessionDir` or a parent of one, `.git` compared after case-folding and NFC/NFD, Windows
  forms refused, link count 1. Uploads are opened by flowctl and handed to the browser as bytes from
  `<flows root>/fixtures/`. The "capped" wording for `flowsDir` is gone from section 1 and section 3 rule 6.
  ADR 0013 carries a pointer.
- **Section 2 and 2a: production.** A production entry covers every scheme and port of its host. The
  `allowReadOnlyReplay` entry has one schema (profiles, sessions, templates with a class, asset paths, session
  max age, expiry), owned here, and the repo cannot change any field. Matching is an allowlist with a defined
  order (raw refusals, one decode, canonical re-encoding, dot segments, case-sensitive exact match), anchored
  value types, an exact header list, no template override of a deny, and defined request classes. Session age
  is judged by `createdAt` inside the file. Evidence is redacted by the origins a run touched, error strings
  are replaced by fixed codes, and flows that would persist page content are refused. The viewer account is the
  containment against request classes flowctl does not know; the verdict oracle is a stated limit.
- **Section 5: destructive confirmation.** No wildcards; the closure comes from ADR 0021 (an allowlist) and the
  confirmation digest has its own `purpose`; an `uncovered` hook is refused. A `destructiveConfirm` schema block
  (kinds `create`, `mutate`, `session`; none for GET; none for `production`). The run ledger is keyed by create
  entry, admits only ids never seen before, is durable and cleaned by `flowctl cleanup <run>`; bodies, queries
  and headers are closed lists; the owner screen follows the display rules of ADR 0025 and shows entries
  derived from a recorded local run. `defaultEnv` is a scope change changed only by an owner-signed command.
  `QA-` and cleanup extend to hand-written CRUD flows on `shared`.
