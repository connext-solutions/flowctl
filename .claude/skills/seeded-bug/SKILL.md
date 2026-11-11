---
name: seeded-bug
description: Use when adding an assertion kind, changing the verifier, or proving flowctl catches a class of defect. Adds a switchable defect to fixture-app and an accuracy test showing a correct run reports it as failed.
---

# Add a seeded bug

flowctl's "accurate" goal is measured here: every assertion kind should catch at least one defect that no
other assertion catches, and the clean app must pass. Every kind is covered today, including `url` (`redirectWrong`) and `value`
(`formNotReset`); the coverage list is in `packages/fixture-app/AGENTS.md`.

1. **Name the defect** a real app could ship (wrong status, nothing saved, wrong record changed, toast on
   failure, missing validation, visible to the wrong role…). Pick the assertion that should be the *only*
   thing catching it.
2. **Add the mode** to `BUG_MODES` in `packages/fixture-app/src/server.ts` with a JSDoc `@remarks` line.
   Implement it as a branch on `bug === '<mode>'` (server) or `window.BUG` (page script in `pages.ts`).
3. **Cover it with a flow.** Extend a sample flow in `packages/fixture-app/flows/` or add one (tag `fixture`).
   The assertion is written from the intended behaviour, never from what the buggy app shows.
4. **Map it** in `CAUGHT_BY` (`packages/core/test/seeded-bugs.accuracy.test.ts`), or in the exploration
   accuracy test if it is about exploration.
5. **Prove the assertion is load-bearing:** temporarily delete that one assertion and run
   `bun run test:accuracy` — the new mode must now be reported `passed` (missed). Restore it; it must be `failed`.
   If it is still caught without the assertion, another assertion catches it: pick a sharper defect.
6. Run `bun run test:accuracy`: the clean app passes, every mode fails. Add the row to `packages/fixture-app/README.md`.

Never weaken, rename or delete an existing mode to make a test pass.
