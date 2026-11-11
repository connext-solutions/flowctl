---
paths:
  - "packages/**"
---

# Architecture rules

- Dependency direction: `cli → core`. `core` never imports `cli`. No `src/` imports `fixture-app`; only tests do.
- Across packages, import the package name (its `src/index.ts` interface). Never deep-import another package's files.
- Inside `core`, other folders import a folder through its `index.ts` (`../run/index.js`), not its files.
- Anything that opens, switches or closes browser contexts of a run goes through `RunSession`.
- Add a seam (an interface with swappable adapters) only when two adapters exist. One adapter = keep it concrete.
- Before adding a module, apply the deletion test: if deleting it would not push complexity into callers, do not add it.
