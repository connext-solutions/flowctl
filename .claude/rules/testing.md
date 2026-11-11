---
paths:
  - "**/test/**"
---

# Testing rules

- Tier by file name: `*.test.ts` = unit (no browser, may use localhost), `*.browser.test.ts` = Playwright + fixture-app,
  `*.accuracy.test.ts` = seeded bugs, `*.contract.test.ts` = real external services (TypeSafe Jev), opt-in via
  `bun run test:contract`, never in `verify`. `bun run check` runs only unit; `bun run verify` runs the rest except contract.
- Exploration tests use the scripted fake System 1 from fixture-app (`startFakeSystem1`); never call TypeSafe outside the contract tier.
- Test through the module's interface. If a test needs to reach past it, the module is the wrong shape.
- Never mock Playwright. Browser behaviour is tested against `@flowctl/fixture-app`.
- Every assertion kind should have a seeded bug that only it catches. Never weaken or delete a seeded bug to make a test pass.
- A failing accuracy test means the verifier or a flow is wrong; inspect the run's `run.json` before changing anything.
