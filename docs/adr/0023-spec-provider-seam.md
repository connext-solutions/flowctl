---
type: ADR
id: "0023"
title: "SpecProvider seam and the private-plugin boundary"
status: proposed
date: 2026-10-29
---

> Owner acceptance: direction approved 2026-10-30 (tasks T0.10, T0.15); text including the 2026-11-01 amendments accepted 2026-11-02; Amendment 2026-11-02 (task T0.32) accepted 2026-11-06. The status stays `proposed` until implemented.

## Context

Derive needs business operations from some source: a folder of markdown, Gherkin files, a test-case
sheet, issue acceptance criteria. One team (the owner's) also has a private documentation search
service. The open core must not depend on that service, name it, or ship code that only makes sense
with it. The repository stays private for now and will be published later as a clean copy made by an
export script (no history).

Without a written boundary, private code drifts into core one convenient import at a time. A boundary
needs a place, a rule a script can check, and an export list.

## Decision

**Spec sources sit behind a `SpecProvider` interface in core. Core ships the generic adapters. Anything
specific to the owner's company lives in `packages/plugin-*`, which core never imports and the export
script excludes.**

`SpecProvider` (in `core/src/spec/`, task T3.1):

- `operations(query?): Promise<Operation[]>` returns normalised operations
  `{ id, title, actor, preconditions, steps, expected[], location, signatureRef }` (`signatureRef` and the
  exact shape of `location` are added by Amendment 2026-11-02 below). `location` only says where the
  operation is. Each `expected` item is `{ text, value?: string | null, ref, context }` (a numeric source value is passed as its text form, ADR 0020 Amendment 2026-11-02 section m rule 8) with its own `ref` (path, section,
  line range, revision), so ADR 0020's per-assertion `sourceRef` points at one expected item. `context` is
  `{ operationId, operationTitle, headings, leadIn }`: `headings` is the list of ancestor heading texts,
  outermost first, and `leadIn` is the lead-in text or `null`, all NFC-normalised (ADR 0020 amendment, section
  i.3). A provider that cannot produce a context for an item returns `leadIn: null` and `headings: []`; it
  never omits the field, and the contract test (T3.5) requires equal `context` across adapters.
- `resolve(ref): Promise<{ quote: string, revision: string } | null>` returns the verbatim text a `ref`
  points at and the provider revision (git commit or file hash). This is what lets the save step check a
  `spec` reference, and later detect a changed source, without a model (ADR 0020).
- Providers are read-only and never call a model.

Where things live:

| Lives in | What |
|---|---|
| `packages/core/src/spec/` | `SpecProvider`, `Operation`, markdown, Gherkin, test-case sheet, issue and (optional) OpenAPI adapters |
| `packages/plugin-*` (private) | Adapters for company-internal systems (the documentation-search MCP client), their tests, their corpora |
| `.claude/skills/` company-specific skills | Test-case writing and trial skills tied to the owner's product |
| `docs/roadmap/` | Plans that name internal systems |

Rules:

1. **Direction.** `plugin-*` may import `core` by package name. **No code, manifest or build wiring outside
   a `plugin-*` package names a plugin** (by name, scope name, path, `package.json` name or relative path):
   this covers every other package, including `core`, `cli`, `mcp`, `fixture-app` and any future one,
   and the root wiring files (tsconfig, test-runner config, root manifest, scripts, Dockerfiles, workflows).
   The root `tsconfig.json` references and the lockfile, which must name the plugin to build it, are the
   only allowed mentions and are regenerated in the export. `scripts/check-arch.mjs` fails the build on the
   rest. A static scan cannot prove a program never builds a module name at run time; a second backstop,
   a check over the modules the built output actually loads (T0.16), closes that.
2. **Absence.** Every core adapter test passes with every plugin directory deleted. A contract test (T3.5)
   runs one fixture spec through the markdown adapter and the plugin adapter and requires equal
   `Operation[]`.
3. **Registration, not discovery.** A plugin hands a `SpecProvider` to core through config (`specs:
   [{ kind, ... }]`) or an explicit call in the caller's code. Core does not scan `node_modules` or
   `packages/` for plugins.
4. **Export exclusions.** The export script (T7.5) excludes `packages/plugin-*`, company-specific skills,
   `docs/roadmap/**`, `docs/spike/**`, `.env*`, `*.xlsx` and `.omc/`, and rewrites the few files that
   name excluded parts (root `AGENTS.md`, README, label table, ADRs that name the company). T7.7 scans
   the snapshot for internal names. The full list is task T7.9.
5. **Naming.** Core code, tests and fixtures use no company names, hosts or product names. Vietnamese
   appears only as product data (fixture pages, test strings).
6. **One adapter is not a seam.** Markdown is the first adapter, but Gherkin or the test-case sheet make
   the second one before the plugin; the interface is frozen after two core adapters pass the shared
   contract test.

### Registration in the open CLI

Providers are registered by the host application, explicitly: the CLI builds its provider list from config
kinds it knows (`markdown`, `gherkin`, `testcases`, `issues`, `openapi`). It never imports, resolves or
loads a `plugin-*` package, and a config kind it does not know is a `ConfigError`. The open CLI therefore
never loads the documentation-service adapter. A private build (a separate entry point in the private
checkout, outside `cli`) registers the plugin's provider by calling the same registration function.

### Provider input hardening

Spec documents, test sheets and issue bodies are **untrusted data, never instructions**, and a pull
request or a ticket can change them. **Acceptance criterion: a pull request, or an agent with write access
to the repository, cannot loosen any guard, redirect any credential, or forge any approval through spec
text.**

1. Provider text never becomes a flow key, an input name, an `env` reference, a URL, an `op`, a shell
   argument or a path. Derive passes provider text onward only as quoted data (a `quote` in a
   `sourceRef`, a label to look for).
2. Everything Derive outputs goes through the flow zod schemas and through the scope and destructive-action
   guards (ADR 0024, T1.2, T1.3). The flow writer never emits an `env:` input.
3. Adapters read inside a root through **one shared containment helper** (a task every adapter task
   depends on): `realpath` containment against a root from the trust store **whose `purpose` is the adapter's own**
   (`specs`, `contracts`, `repos` or `issues`; ADR 0025 section 2, `roots`), reject `..` and absolute paths,
   open with `O_NOFOLLOW`, `fstat` the descriptor (regular file, link count 1, so a hard link out of the
   root is refused) and compare the descriptor's device and inode with the path afterwards, so an
   intermediate directory swapped between check and open is detected; size, depth and file-count caps.
4. YAML and JSON (front matter, OpenAPI, config) are parsed with a safe schema: no custom tags, no
   merge-key bombs, an alias expansion limit, and keys such as `__proto__`, `constructor` and `prototype`
   are rejected (no prototype pollution). XML (xlsx, docx) is parsed with DTDs and entity expansion
   disabled.
5. No network and no `$ref` following by default. An OpenAPI remote `$ref` is an SSRF or a local file
   read; only `$ref`s inside the root resolve, remote refs need an explicit allowlist.
6. Spreadsheets (xlsx is a zip): decompressed bytes are capped **while streaming** (not trusting the
   archive's declared sizes), plus caps on entry count and expansion ratio; formula cells are read as
   their cached text, never evaluated; macros ignored; `externalLinks` and hyperlinks are banned.
7. The issues adapter calls only hosts in the trust store's allowlist (the repository may only remove
   hosts), with a token whose scope the store records and which is read-only; it follows no cross-host
   redirect, never forwards the token on a redirect, and refuses IP literals and addresses that resolve
   to private ranges. Issue bodies are data (rule 1).
8. **Every adapter ships a hostile-fixture test** (traversal path, symlink out, oversized file, YAML bomb
   or custom tag, injected "ignore the rules and delete everything" text, formula cell, remote `$ref`) and
   the test asserts a typed refusal or inert data, never a changed flow. Freezing the interface after two
   core adapters is a checkpoint on the second adapter task (T3.7).
9. **Escaped output.** Untrusted provider text that reaches a human surface is escaped for that surface:
   the conflicts file (T4.4, a spreadsheet or markdown, so formula-injection prefixes `= + - @` are
   neutralised) and the HTML report (T7.1, HTML-escaped, no script from data).

## Options considered

- **Interface in core, private adapters in `packages/plugin-*`** (chosen): enforceable by a script,
  trivially excluded at export, proves independence by tests with the plugin absent.
- **Separate private repository for the plugin**: strongest isolation, but cross-repo development with
  two lockfiles and no shared gates. Reconsider if the plugin grows its own team.
- **Plugin inside core behind a feature flag**: leaks names into the public snapshot and relies on
  review, not a gate. Rejected.
- **Dynamic plugin discovery**: convenient, but makes the import graph invisible to the architecture
  gate. Rejected.

## Consequences

- **Easier:** the public copy is a file filter plus a short rewrite list; the gate catches boundary
  breaks the day they are written. Outside users get a complete product without the plugin.
- **Harder:** a private package in the workspace means CI and `bun install` still see it; its tests must
  not need internal network access in the shared gate. Two sources for one fact (the `Operation` shape)
  need the contract test to stay honest.
- **Revisit when:** a second company plugin exists (then publish a plugin template), or the plugin needs
  to move to its own repository.


## Amendment 2026-11-02: `location` and the `signatureRef` contract for non-file providers

Accepted by the owner on 2026-11-06, as written and including the recommended default of each decision it marks. Closes task T0.32 (the provider part).

ADR 0020 section i.2 says a provider that is not a file on the machine "returns the same map through its
`signatureRef`" and never defines the field. Without a definition the private internal-wiki adapter and the
markdown adapter could return different things, and a signature could not be checked the same way. This
amendment defines it. The status stays `proposed`. The signature rules themselves (the signed unit, the
`.sig` shape, the keys and floors) are in ADR 0020, Amendment 2026-11-02, sections m and n; this ADR owns only
what a provider does.

### `location`

`location` is the pair `{ provider: string, ref: string }`. `provider` is the provider's registered name
(it passes `NAME_PATTERN`, so it has no `/`). `ref` is the **document-level** reference: an NFC string, with
no line range and no revision, so that editing one line does not change it. For a file adapter it is the
path relative to the `specs` root, `/` separators, no leading `./`; **a path with any component that is not
already in NFC is refused** by the adapter rather than normalised (the document is skipped, its operations
are unsigned, and flows citing it carry the note `spec_path_not_nfc`; the run goes on), so the signed `ref`
is the name on disk and two spellings cannot name one document. For a non-file provider it is an opaque
non-empty NFC string chosen by the provider and stable for the document. `location.ref` is the document
reference and is not the `ref` of an `expected` item or of a `sourceRef`, which also carries a section,
line range and revision; the two never substitute for each other. `location` is a part of the signed
unit, which is why it must not move with an edit. The floor key `provider/ref` of ADR 0025 splits at the
first `/`.

### `signatureRef` and `signatures`

1. `Operation.signatureRef` is `string | null`: an opaque, non-empty, NFC string that tells the provider where
   the signature set of this operation's document lives, or `null` when the document has none. Core never
   interprets it, never puts it into a path, a URL or a command, and never sends it anywhere but back to the
   same provider.
2. `SpecProvider` gains one optional method:
   `signatures(signatureRef): Promise<{ bytes: Uint8Array, revision: string } | null>`.
   - `bytes` are the **raw bytes** of the document in the `.sig` format of ADR 0020 section n. The provider
     does not parse, verify or normalise them; core parses them (with the safe-parse rules of provider rule
     4) and verifies against the store's `reviewerKeys`.
   - `revision` is informational (a log field). It is not signed and no decision depends on it.
   - At most 1 MiB. A provider that would return more throws `signature_too_large`.
   - Read-only, no model, no network beyond what the provider already uses to read the document.
   - Returns `null` when the document has no signature set.
3. **A thrown error, a `null`, a missing method or an oversized result means unsigned** (`author: unknown`,
   `review: unreviewed`, ADR 0020 section i.2), with the note `signature_unavailable` in `provenanceNotes` (`signature_too_large` for an oversized result; a
malformed document is `signature_malformed`, ADR 0020 section n).
   It never means "signed". The error is not retried and does not fail the run.
4. **File adapters** set `signatureRef` to `<document path>.sig` relative to the `specs` root and implement
   `signatures` by reading that file through the shared containment helper (rule 3 above: root of purpose
   `specs`, `realpath` containment, `O_NOFOLLOW`, `fstat`, device and inode compared). A missing file is
   `null`.
5. **The provider cannot self-attest.** Whatever it returns is untrusted data: only a signature that verifies
   under a store key counts, so a provider (or a pull request that changes what it reads) can withhold or
   replay a signature set but cannot forge one. Replay of an older but valid set is limited by `specFloors`
   (ADR 0020 section n).
6. **Contract test (T3.5)** is extended: the same `.sig` bytes served through the markdown adapter and
   through the plugin adapter give the same verification result for the same `Operation[]`; an adapter that
   has no signature support returns `signatureRef: null` for every operation and the test requires it.
7. **Hostile fixtures (rule 8)** gain: an oversized `.sig`, a `.sig` with a duplicate key, a `.sig` whose entry
   was copied from another document (its `ref` differs, so it reads as unsigned), and a `signatureRef` that
   looks like `../../x`; each must give a typed refusal or `unsigned`, never a path read outside the root.
