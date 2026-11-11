---
name: write-adr
description: Use when a design decision is made or reversed in flowctl - a new invariant, flow format or protocol change, default, dependency, or superseding an existing ADR.
---

# Write an ADR

1. Next number: highest `docs/adr/NNNN-*.md` + 1. File name `NNNN-short-name.md` (short, kebab, ASCII).
2. Frontmatter and sections exactly as `docs/adr/README.md` → Format: `type`, `id`, `title`, `status`, `date`;
   `## Context`, `## Decision`, `## Options considered`, `## Consequences` (Easier / Harder / Revisit when), optional `## Advice`.
3. Write in English, short sentences, numbers from measurements where they exist (spike, trials, tests).
4. Status: `proposed` when decided but not built, `accepted` when built, `active` when in daily team use.
5. Superseding: never rewrite an `active` decision. New ADR states what it replaces; old one gets
   `status: superseded` and `superseded_by: "NNNN"`.
6. Add the row to the Index table in `docs/adr/README.md`. Reference it from code JSDoc with `@see docs/adr/NNNN-….md` where the rule is enforced.
7. Never cite internal specs or plans; the ADR must stand alone.
