---
paths:
  - "**/*.ts"
---

# TypeScript rules

- `strict` + `noUncheckedIndexedAccess`; handle `undefined` from index access explicitly.
- No `any`. Avoid `as`; use type guards. Allowed: `as const`, and the documented casts in `flow/templates.ts#mapStrings`.
- `??` instead of `||` for defaults.
- Relative imports end in `.js`. Across packages use the package name.
- Files under 250 lines, 300 at most; split by responsibility. Create a folder only when it will hold ≥ 3 files.
- Dates only through dayjs.
- Comments follow `.claude/rules/comments.md` (JSDoc with tags, no inline comments).
- `bun run fmt` formats; never hand-format against `.oxfmtrc.json`.
