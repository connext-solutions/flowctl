---
type: ADR
id: "0035"
title: "The code index walks contained files with a lexer; it never runs git"
status: accepted
date: 2026-11-12
---

## Context

Reconcile (roadmap section 3.6) has to match a failed or ambiguous case to the code behind it: the route that
serves a URL, the i18n label that holds a text, the validator that emits a message. The failure classifier (T6.2)
and the coverage-gap report (T6.4) read this index; it is the first reader of a root of purpose `repos`
(ADR 0025 section 2).

The repository being indexed is untrusted input, like a spec folder (ADR 0023 rule 3). It can hold links that
point out of the checkout, hard links, FIFOs, huge or binary files, files that are not UTF-8, names that are not
NFC, and a `.git` directory with its own config (`core.fsmonitor`, `diff.external`, textconv drivers, include
paths). The task text proposed `git grep`. Running git inside such a repository hands control to that config
unless every knob is turned off, and git reads files under its own rules, not the containment rules of ADR 0024
section 1a: it does not refuse a hard link out of the root or a non-NFC name, and a size cap only applies to its
output, after the work is done.

## Decision

1. **Scope.** `buildCodeIndex(root, opts)` in `core/src/reconcile/code/` (layer `reconcile`) takes a
   `ContainedRoot` of purpose `repos` and returns a deterministic `CodeIndex`, frozen down to every record and
   every lookup answer:
   - **routes**: the route table, from an ordered, extensible list of extractors (`ROUTE_EXTRACTORS`, or the
     caller's list): React Router `<Route path>` elements, route objects with `path` and `children` (React Router
     `createBrowserRouter`, Vue Router, Angular `Routes`; read only in a file that names a router API), and
     file-system routes (Next.js App Router, Next.js Pages Router, Remix flat routes). Nested routes are joined
     into a full path;
   - **labels**: string leaves of locale JSON files (a `.json` file below a folder such as `i18n`, `locales`,
     `messages`), by dotted key, with the locale when the file or folder name is a locale code;
   - **messages**: string literals that are validator messages (arguments of validator methods such as `.min`,
     `.required`, `.regex`, yup `.test`; values of `message`, `required`, `required_error`, …) in a file that
     imports a validation or form library.
   Every record has a file and a 1-based line. Components and AST-level lookups are not in scope; they are
   added only if the classifier shows that this is not enough.
2. **Walk, do not spawn.** Files are listed with `walkContained` and read with `readContained` (ADR 0023 rule 3,
   ADR 0024 section 1a). No process is started and no git config, attribute or hook is consulted. Source is split
   by a small linear lexer (strings with escapes decoded, comments and regular expressions skipped) and locale
   files by a strict JSON reader that keeps lines. `walkContained` gains a `prune` option so dependency and build
   folders (`node_modules`, `dist`, `build`, …) are not entered (each is reported as `pruned`), and an `include`
   predicate so files the index never reads or routes (images, fonts, documents) are neither listed nor charged
   to the byte budget; dot folders were already never entered. The root is checked again after the last read; a
   root that changed refuses the build, and a file the system refuses to read is skipped as `unreadable`.
3. **Lookups match exactly.** `findLabel(text)` and `findMessage(text)` compare whole texts after the
   normalisation of ADR 0020 section d (NFC, ASCII whitespace collapsed, trimmed); a text with a hidden,
   compatibility or non-ASCII digit character is refused, in the index (skipped with its line) and in a query
   (`refused`). There is no substring search. `findRoute(path)` takes a concrete path or URL, drops query and
   fragment, normalises it as scope paths are (ADR 0024 section 3, `normalisePath`) and returns the routes whose
   pattern matches it segment by segment, most specific first.
4. **Bounded.** Files read (5,000), directory entries per walk (10,000; each `dirs` entry is one walk), bytes
   (64 MiB, walked and actually read), bytes per file (1 MiB, larger files are skipped), records (100,000, skipped
   entries included) and matches per query (20) are capped; passing a build cap
   refuses the whole build (`ContainmentError` `too_large`) rather than returning a partial index. A file that is
   binary (a NUL byte), UTF-16 or not valid UTF-8, or not strict JSON is skipped and listed in `skipped` with
   its rule. The lexer and the extractors are linear, with fixed caps where a scan could nest: route declarations
   nest at most 32 deep (`route too deep`) and a joined route path has at most 32 segments and 1,024 characters
   (`route too long`), so each full path is joined once from its parent's; validator calls are tracked on one
   stack; an unclosed quote or regular expression is scanned once, and a later one of the same kind before the
   point where that scan stopped is read as punctuation; a `\u{…}` escape has at most 8 hex digits. Each is
   tested against about 1 MiB of hostile input with a wall-clock budget.
5. **Not public yet.** Exported through `reconcile/index.ts`; `src/index.ts` exports it when a caller (T6.2,
   T6.6) needs it. The store's `roots` reader will build the `ContainedRoot`; until then the caller opens it.

## Options considered

- **`git grep` in a child process** (the task text): fast, honours `.gitignore`, and matches tracked files only.
  Safe use needs `--no-ext-diff`, `-c core.fsmonitor=false`, no textconv, a scrubbed environment without `GIT_*`
  variables, a contained working directory, a timeout and capped output, and the output is still untrusted text
  to parse. Even then git follows its own file rules, not the containment rules, and a search touches every
  tracked file before any cap applies. Rejected: the walk keeps every guarantee of the containment helper with
  no subprocess, and the index needs file and line, which the lexer gives directly.
- **A full parser** (TypeScript compiler API or a JavaScript parser): exact, but a new heavy dependency for
  a lookup aid, and parsing JSX, Vue and TypeScript variants is more than the classifier needs. Kept as a later
  option behind the same records.
- **Regular expressions over raw text**: simplest, but a quote or comment breaks a pattern silently and nested
  routes cannot be joined. The lexer costs little more and recovers from a stray quote on the same line.

## Consequences

- The index never reads outside the root, through a link or a hard link, and never starts git; the containment
  tests of `trust/contain/` cover its file access, and its own tests cover symlinked files and folders, hard
  links, path traversal in `dirs`, huge, binary, UTF-16, invalid UTF-8 and non-NFC files.
- `.gitignore` is not read: ignored folders other than the pruned names are indexed. A caller narrows the walk
  with `dirs` (for example `['src']`). A pruned folder is listed in `skipped` as `pruned`, so routes or labels
  kept in a folder named like build output (`build/`, `out/`, `vendor/`) are visibly missing rather than silently
  so; a caller that needs them passes its own `prune` set.
- The lexer is not a parser: a computed route path or message (a constant, a template with a substitution) is
  not indexed, and JSX text with an unbalanced quote or `//` can hide a declaration on that line. The
  classifier must treat "not found" as "not found in the index", never as proof that the code lacks it.
- Messages that are i18n keys (`.min(1, 'form.required')`) are indexed as written; joining them to labels is
  left to the classifier.
