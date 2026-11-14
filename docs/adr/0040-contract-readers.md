---
type: ADR
id: "0040"
title: "Contract readers parse static text with fixed rules, emit facts and consistency checks, and never run what they read"
status: proposed
date: 2026-11-14
---

## Context

ADR 0020 gives every generated assertion a typed `sourceRef`. The `contract` kind points at a contract in the code
under test: an OpenAPI schema, a form validator (zod, Joi, HTML `required`, `maxlength`, `pattern`) or an i18n message
key. The value is read from the file, never paraphrased, and `check` reads it again later. Such assertions test
consistency (client against server validation, message shown against the catalogue, response against schema); they do
not prove business correctness.

The code under test is untrusted input, like a spec folder (ADR 0023 rule 3, ADR 0035). A contract file can be a link
or a hard link out of the root, a FIFO, a YAML bomb, a file with custom tags, a `$ref` to a URL or to `/etc/passwd`,
or a TypeScript file that would run a command if it were imported. ADR 0020 section d already says the readers
parse statically: never `import`, `require` or evaluate the file.

## Decision

1. **Scope.** `core/src/derive/contract/` (layer `derive`, not exported from the package yet) reads a `ContainedRoot`
   of purpose `contracts` and returns `ContractFact`s and skips (`readContracts`), consistency checks built from facts
   only (`checkConsistency`), a reference per fact (`contractRef`) and the re-read of a reference
   (`resolveContractRef`). GraphQL schemas, ICU message syntax and YAML or `.properties` catalogues are out of scope.
   The task that builds assertions (T4.3) wraps the facts; this module builds no flow, step, assertion or verdict.
2. **Files are read only through the containment helper** (`trust/contain`: `walkContained`, `readContained`,
   `ByteBudget`). The reader takes a `ContainedRoot`, checks its purpose, and gives the same refusals as every other
   reader. Only the extensions of the readers are listed (`.yaml`, `.yml`, `.json`, `.html`, `.htm`, JS and TS), and
   `node_modules` and build folders are not entered. A bound that is passed (entries, bytes, files, facts, references)
   refuses the whole read; a file over its cap, a link, a hard link, a FIFO, a name that is not NFC and bytes that are
   not UTF-8 are skips with a fixed reason.
3. **No new dependency.** YAML and JSON go through `yaml` with the options of the markdown front matter (failsafe
   schema, no merge keys, strict), after a linear pre-scan that refuses a text with more lines and commas than
   `maxNodes`, or deeper indentation or flow nesting than `maxDepth` allows, so the limits bound the parse and not
   only its result; duplicate keys are found in the walk with a `Map`, because the parser's own check is quadratic.
   Then the data is walked by the reader: no anchors, aliases or explicit
   tags, no key named `__proto__`, `constructor`, `prototype` or `<<`, bounded depth, nodes and string length. JSON is
   read as YAML, so duplicate keys are refused. Mappings are `Map`s. zod and Joi are read by a restricted lexer (a
   trimmed copy of the one in `reconcile/code/`, which derive may not import) and a recognizer of the shape
   `ns.object({ key: ns.method(literal)... })`. A regular expression literal is kept as text and never compiled. A
   key whose value is a variable, a spread, a computed key or an imported schema, a method the reader does not know and
   a non-literal argument are skips with file and line, never guesses. Nothing is imported, required, evaluated,
   compiled from file text or spawned; `check-arch` forbids `child_process` in this folder.
4. **Numbers have one reading.** `canonicalNumber` accepts plain decimals (and, in source code, a plain exponent) and
   refuses leading zeros, a plus sign, `.5`, hex, digit separators and more than 15 digits. A value that is refused is a
   skip, so two sources can only agree by reading the same number the program that consumes it reads.
5. **`$ref`.** An OpenAPI reference is followed inside the document, or to another file below the same root through
   `readContained`, with a cap on hops per file. A scheme (`http:`, `file:`), an absolute or backslash path, a path
   that leaves the root, an anchor, a pointer through a prototype name, a cycle and a chain past 32 hops are skips.
   Facts are only emitted from the file they are read from, so a reference into another file gives a link, not facts.
6. **Facts and references.** A fact is `{ source, side, file, line, pointer, owner, field, rule, value, messageKey? }`.
   `side` is `client` for HTML and zod, `server` for OpenAPI and Joi and `catalogue` for i18n (the caller may override).
   A reference is `<rootName>:<relative/path>#<JSON Pointer>`, at most 500 characters, with no invisible character
   (`INVISIBLE_CLASS`); a fact whose file, pointer, owner, field, key or value is longer, holds one, or would make a
   longer reference is a skip, not a fact. Within one read every emitted reference is unique and
   `resolveContractRef` returns exactly that fact: pointers are structurally unique (`/required/<index>`, the owner
   of a nested schema is its top variable, a repeated rule is `rule.2`, a repeated control `name#2`), and the emitter
   turns any pointer taken twice into an `ambiguous_ref` skip. A fact read through a same-file `$ref` is keyed by the
   referring place (its pointer, then `$ref`), so operations that share a component each keep their facts. A key
   written twice in a schema is read once, the last (as JavaScript does). Schemas per file and keys per schema are
   capped (`too_many_schemas`, `too_many_keys`). The root name is 1 to 64 letters, digits, `_` or `-`. `resolveContractRef` reads
   the file again, extracts its facts and returns the first with that reference, with its value and the SHA-256 of the
   file; `null` means the file or fact is gone, a different value means the source changed. A fact has no integer
   revision; the caller stores `quoteSha256` of the value (`valueSha256`).
7. **Consistency checks.** `client_server` compares, per field named by both sides, the comparable rules as `equal`,
   `differs` or `missing` on one side. `message_i18n` looks each message key up per locale (the folder of `locales/<lang>/<namespace>.json`, else the file name; `equal`, `missing`, or
   `unknown` for text that is not a dotted key and when no catalogue was read). `response_schema` checks that the
   field names of an error response's `field` enum are properties of the request schema, through `allOf`. A side that
   cannot be judged is `unknown`, never `equal`. A check carries facts and a fixed `reason` code, no text of its own.
8. **Hostile fixtures** (ADR 0023 rule 8) cover every format: traversal, symbolic and hard links, FIFO, oversized
   files, too many files, a too deep tree, non-NFC and dot names, a root of the wrong purpose or swapped, non-UTF-8
   bytes, YAML bombs, custom tags, merge and duplicate keys, prototype keys, 10,000 levels of nesting, remote and
   escaping references, cycles, injected instruction text (kept as data), source that would run code (never run), a
   catastrophic regular expression (kept as text) and unterminated tokens.

## Options considered

- **A TypeScript or HTML parser as a runtime dependency** (`typescript`, `acorn`, `parse5`): exact syntax for real
  code, but a new dependency with its own nesting and size attack surface, and the fixed rules above already say what
  the reader may read. Rejected for now; revisit with a measurement if a real codebase shows too many skips.
- **Importing the lexer from `reconcile/code/`**: the layer rule forbids it (derive is below reconcile). Moving it to a
  lower layer is a separate rename; a trimmed copy with the `dup-ok` mark keeps this task small.
- **Following `$ref`s to other files for facts**: needs pointers across files and a visited set across a graph; a
  link fact is enough for the checks above.
- **Building assertions here**: pre-empts the vacuity, polarity and template checks of T4.3 and puts verdict-shaped
  objects in a reader. Rejected (ADR 0004).

## Consequences

- **Easier:** T4.3 gets typed, re-readable facts and refs; `check` can re-resolve them; the folder has no
  dependency and a source scan in tests that fails on dynamic loading, process or clock use.
- **Harder:** coverage is partial by design: composed schemas (variables, spreads, imports), `oneOf` and `anyOf` and
  schemas outside `ns.object({...})` are skips. The fixture app has no zod, Joi or HTML form file, so the real-app
  consistency check covers message keys and response fields only; the rest is tested on temporary fixtures.
- **Revisit when:** a real codebase shows that skips dominate, or when a second reader needs the lexer (hoist it to a
  lower layer).
