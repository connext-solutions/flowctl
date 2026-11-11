# AGENTS.md — packages/fixture-app

Root [AGENTS.md](../../AGENTS.md) applies. This package exists to prove flowctl is accurate.

- **Goal: every assertion kind has a bug mode that only it catches.** Covered today: `network` (status,
  requestBody, absent), `text` (held `within` a region: `toastInList`), `noConsoleErrors`, `url`, `value`. A new assertion kind ships with its
  bug mode and an accuracy test in core; use the `seeded-bug` skill.
- Every mode is pinned to a failed assertion in `CAUGHT_BY`, in the flow it is pinned to; other flows
  may still abort first (in `leave-approve` five modes stop at step 6). Persistence bugs
  (`notPersisted`, `list500`, `wrongValueAfterReload`) fail `leave-persist` `text` after reload; `save500` fails
  the `leave-submit` toast `text` and `toastOnFail` its POST `network` status (the toast text comes first).
- Never weaken, rename or delete a bug mode to make a test pass. A failing accuracy test means the
  verifier or the flow is wrong.
- A bug mode is a branch on `bug === '<mode>'` in `src/server.ts` (server side) or on `window.BUG` in
  `src/pages.ts` (client side); add it to `BUG_MODES` with a JSDoc line and to the README table.
  Crawl-class modes (found by the crawler's free checks, not by a flow assertion) go in `CRAWL_BUG_MODES` in
  `src/crawl.ts` instead, with their pages under `/map`; keep `/map` unlinked from the leave pages.
- The fake System 1 (`src/system1.ts`) matches targets by the exact `[id] label` text the client sends.
  A new System 1 operation the fake must answer needs a case here.
- No network access outside localhost; no dependencies beyond Node built-ins.
- The app's UI text is Vietnamese on purpose: it matches the ERP the flows target.
- UI messages live in `contracts/i18n/vi.json` and validation rules in `src/validator.ts`; a new message or rule
  goes there and into `contracts/openapi.yaml`, never inline in a page, so the contract artefacts stay true
  (`core/test/fixture-contracts.test.ts` checks them).

## Why there is no `tsconfig.json`

fixture-app is source-only: nothing imports a built copy, so it has no composite `tsconfig.json`, no `dist/` and is
not in the root `tsconfig.json` references (an exception to the "New package" recipe in the root AGENTS.md). Its
`src/` is type-checked through `tsconfig.tests.json`, which maps `@flowctl/fixture-app` to
`src/index.ts`, and `scripts/check-bundle-plugins.mjs` allowlists it in `SOURCE_ONLY`.
