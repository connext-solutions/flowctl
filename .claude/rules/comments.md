---
paths:
  - "**/*.ts"
---

# Comment rules

Goal: context that search (codegraph, grep) and readers find in one place — on the declaration.

- Avoid inline comments inside function bodies. Put the "why" in the JSDoc of the export, class,
  method or function it belongs to.
- Use JSDoc tags that fit the contract:
  - `@param` / `@returns` when the meaning is not obvious from the name and type;
  - `@throws {ErrorType}` for every error kind a caller must handle (e.g. `RunError` kinds);
  - `@example` for non-trivial usage (flow YAML snippets, call order such as `open → begin → finish`);
  - `@see` to link the ADR that explains a decision (e.g. `@see docs/adr/0010-assertion-semantics.md`);
  - `@remarks` for invariants and ordering constraints;
  - `@internal` for exports used only by the package's own tests.
- One-line summaries are fine for simple exports; never restate the type signature.
- Allowed inline comments: tool directives only — `// oxlint-disable-next-line <rule> -- <reason>`
  and `// dup-ok: <reason>` (required by the duplicate-export hook). Nothing else.
- When you touch a function that carries inline comments, fold them into its JSDoc.
- Browser scripts embedded in `fixture-app/src/pages.ts` are page code, not TypeScript, and are exempt.
