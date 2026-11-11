---
inclusion: fileMatch
fileMatchPattern: '{docs/**,**/*.md}'
---

# Docs rules

- Language: everything committed is English (docs, ADRs, comments, templates, PR and issue text). Vietnamese
  appears only as product data: UI labels of the apps under test, fixture-app pages, flow inputs and test strings.
- ADRs: one decision per file, numbered, frontmatter and sections as in `docs/adr/README.md`.
  An `active` ADR is never rewritten; a new ADR supersedes it (old one gets `status: superseded` +
  `superseded_by`). Status moves and typo fixes are fine. Use the `write-adr` skill.
- Per-feature specs and implementation plans are internal working docs: never commit them and never link to
  them from a committed file (`scripts/check-arch.mjs` fails the build). Lasting decisions go to `docs/adr/`.
- Package-specific recipes and gotchas go in that package's `AGENTS.md`; the root `AGENTS.md` keeps the map,
  commands and invariants. Say each thing in one place.
- README files describe the interface and how to run; they do not repeat AGENTS.md.
