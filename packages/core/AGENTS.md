# AGENTS.md — packages/core

Read the root [AGENTS.md](../../AGENTS.md) first; its invariants apply here. This file adds what is
specific to the engine.

## Layout

| Folder | Owns | Imported as |
|---|---|---|
| `foundation/` | lowest layer: shared names (`NAME_PATTERN`, `ConfigError`), typed errors (`ErrorKind`, `FlowError`, `RunError`, `StepError`), symlink-safe fs (`ensureDirInside`, `writeFileNoFollow`, `assertNotSymlink`); no dependency on any other core folder. Re-exported at the old paths (`config.ts`, `result.ts`, `flow/`, `run/`, `browser/`, `safe-fs.ts`) so existing imports keep working | `../foundation/index.js` |
| `flow/` | YAML schema (zod), step normalisation, templates (`{{uid}}`, `{{today±N}}`, `{{env.X}}`, `{{lbrace}}`; unknown `{{…}}` is a `FlowError`, checked at load; ADR 0026), load/save with comments kept | `../flow/index.js` |
| `run/` | `RunSession` (drives a run: `perform(step)`, `ctx()`, `snapshot()`, `check()`, `finish()`), `profiles.ts` (contexts per profile, internal), `scope-guard.ts` (routes every request of a run's contexts through `inScope`; `perform` and `check` end the run `scope_violation`; `frames.ts` judges every frame URL change and holds cross-site frames), `context-limits.ts` (options and init script of every run context: no service worker, downloads cancelled and noted, WebRTC off best effort), `Evidence` (the only module that writes the run directory: traces, screenshot, network, console, `decisions.jsonl`, `run.json`, pruning), `metrics.ts` (System 1 decisions, round-trip time, tokens and cost in `run.json`; unknown cost is `unknown`, never 0), hooks, outcome, verifier; `request-guard.ts` and `guards.ts` (the request layer of the destructive guard; a replay on `shared` gets a run ledger when stored confirmations apply), `ledger/` (the run ledger of ADR 0024 section 5: `RunLedger` authorises confirmed writes and records created ids, `create.ts` sends a create through `route.fetch` so its id is fsynced before the page sees the answer, the seen-set, end-of-run and `flowctl cleanup` cleanup, and the planning of `trust add destructive` from a recorded run) | `../run/index.js` |
| `trust/` | the trust store (ADR 0025): `TrustStore` (read, validate, owner-signed entries), owner key, hook closure judge and digest (`closure/`), hook consent (`consent/`), hook snapshot and built environment (`hookrun/`), `trust init` with the owner's answers (`init.ts`), signed env entries and `trust add env` (`envs.ts`), the command registry and its guard `requireTrust` (`commands.ts`: a new command is added there with its `guarded` flag), `trust hook` logic (`admin.ts`), destructive confirmations (`confirm/`: schema, rules, digest, strict body reading and request matching, entries derived from a recording, renewal), the run ledger file (`ledger-file.ts`, `ledger-lines.ts`: `O_EXCL`, 0600, hash chain, the read checks), the shared containment helper every spec provider and contract reader reads through (`contain/`: `openRoot`, `readContained`, `walkContained` (with `prune` folder names and an `include` file predicate), `ByteBudget`; ADR 0023 rule 3). `TrustStore.open(dir)` is the test seam; the CLI only opens the default store | `../trust/index.js` |
| `browser/` | locator → Playwright, executor (anti-flaky fill, strict match), snapshot (+ ported script), recorder, `inScope(url, kind, scope)` (pure scope rules of ADR 0024 section 3, `scope.ts`) | `../browser/index.js` |
| `system1/` | `/v1/systemone` protocol, prompts; the `Driver` interface and its only factory `createDriver` with the run-time check `assertDriverFor` (`client.ts`, ADR 0022); the Jev adapter `JevDriver` (`jev.ts`, built only by the factory: `check-arch` fails a construction elsewhere in `src/`); the transport (`wire.ts`: no proxy, no redirect, bundled CA roots only, loopback decided on the connected socket, answer capped after decompression) | `../system1/index.js` |
| `explore/` | `Exploration` loop, `RunView` (decision log, escalations), policy (pure), act, heal, `decisionEntry` (builds redacted log entries) | `../explore/index.js` |
| `spec/` | spec sources (ADR 0023): `Operation` schema, `SpecRegistry` (explicit registration), the markdown adapter `markdownSpecProvider(root)` (`markdown/`: one operation per document, front matter or headings, ordered entries are steps, unordered entries are expected items with their own `ref` and `context`); reads only through `trust/contain/`. `text.ts`: the ADR 0020 text rules every reader of spec text shares (`normText`, `refusal`, `INVISIBLE_CLASS`, token-boundary `occurrences`, `quotedSpans`). Not exported from the package yet | `../spec/index.js` |
| `observe/` | the read-only crawler (`observe()`, ADR 0033): breadth-first through same-window links in the `visit` scope, one `RunSession` whose request layer is `RequestGuard.forCrawl` (only reads leave the browser, on every env class; a refused request is recorded on its page), the page reader (`page-script.ts`, never a field value; page text through `redactText`), link rules (`links.ts`, pure), per-page calls and console errors (`capture.ts`), the page budget (`budget.ts`), the caller summary (`observeSummary`, no top-level verdict), the free checks (`checks/`: `freeChecks(map)`, pure, five rules from the map alone, each finding with an `invariant` sourceRef and an `observation` JSON Pointer into `appmap.json`; `checks.json` beside the map, not written when the run ended in an error), the `--out` copy rules (`output.ts`), and the `AppMap` schema; `appmap.json` goes through `Evidence.artefact`; a `production` env is refused before any browser starts | `../observe/index.js` |
| `derive/` | Derive (roadmap section 3.4). `match/`: the matcher `matchOperations(ops, map)` (ADR 0034; pure, no model): per operation the candidate screens with a score and grounded evidence (a span of the operation's text, an element of the `AppMap`), every quoted literal with the elements it equals, the unmatched steps; the case fold in `match/text.ts` (the other text rules are `spec/text.ts`'s). `conflicts.ts`: spec ≠ app disagreements from a report (`findConflicts`) written as `conflicts.md` and `conflicts.json` (`writeConflicts`), untrusted text escaped by `escape.ts`. Not exported from the package yet | `../derive/index.js` |
| `reconcile/` | roadmap section 3.6: the read-only code index (`code/`, T6.1, ADR 0035): `buildCodeIndex(root)` over a root of purpose `repos` gives routes (an extensible `ROUTE_EXTRACTORS` list: React Router JSX, route objects, Next.js, Remix), locale JSON labels and validator messages, each with file and line, and `findLabel` / `findRoute` / `findMessage` with exact matching after ADR 0020 normalisation; reads only through `trust/contain/` (with `prune` for `node_modules` and build folders, reported as `pruned`, and `include` so files it never reads are not listed or charged), never runs git (`check-arch` fails a `child_process` import under `reconcile/`). Not exported from the package yet | `../reconcile/index.js` |
| `config/` | the effective configuration (ADR 0024 section 1): `effectiveConfig(cfg, trusted)` intersects the repo config with the trust store and the built-in ceilings (`CEILINGS`, `MIN_CONFIDENCE`) and returns the warnings; refusals are recorded on `LoadedConfig.trustView` and raised by `resolveEnv` (`env_not_trusted`). Layer `config`, same as `config.ts` | `../config/index.js` |
| top level | `config.ts`, `replay.ts`, `save.ts`, `login.ts`, `result.ts`, `safe-fs.ts` (all re-export from `foundation/`; `safe-fs.ts` kept as the stable public path for the fs helpers), `index.ts` | — |

Dependency direction inside core (enforced by `scripts/check-arch.mjs`, list in `scripts/core-layers.mjs`):
`foundation` ← `flow` ← `browser` ← `run` ← `system1` ← `explore` ← `spec` ← `observe` ← `derive` ← `reconcile` ← entry files (`replay.ts`, `save.ts`, `login.ts`, `index.ts`).
A folder imports only folders to its left, always through their `index.ts`. `foundation/` is the lowest layer,
imported by anything; `config.ts`, `result.ts` and `safe-fs.ts` are leaves that now re-export from it.

## Where to change what

| Change | Touch |
|---|---|
| New step kind | `flow/schema.ts` + `flow/steps.ts` (normalise + `serializeStep`) + `browser/executor.ts` (`perform`) + a browser test on fixture-app. A step that changes the run itself (profile, navigation) goes in `RunSession.perform` instead |
| New assertion kind | `flow/schema.ts` + `run/verifier.ts` + a seeded bug in fixture-app that only this assertion catches + the accuracy test |
| New System 1 operation | `system1/protocol.ts` (OPS) + `system1/prompts.ts` (OP_TEXT) + `explore/request.ts` + `explore/act.ts` + a `policy.test.ts` case + `fixture-app/src/system1.ts` if the fake must answer it |
| Exploration stop/escalation rule | `explore/policy.ts` (pure, unit-tested) or `explore/exploration.ts` + `explore.browser.test.ts` |
| New config key | `config.ts` (zod schema with a default) + `config.test.ts` + README quickstart if users set it |
| New public export | `src/index.ts`, then update `test/api.test.ts` (the interface snapshot) on purpose |
| New free check | `observe/checks/schema.ts` (`CHECK_IDS`, and the pointer pattern if it points at a new map field) + `observe/checks/rules.ts` (`RULES`) + a case in `test/observe-checks.test.ts` + a crawl-class seeded bug in fixture-app (`CRAWL_BUG_MODES`) mapped in `test/observe-checks.accuracy.test.ts` |

## Gotchas (each one cost a debugging session)

- **`network` assertions see only fetch/xhr.** A Vite dev server serves `.tsx` modules whose URLs match globs like `*holiday*`; counting them gave a false `passed`.
- **Evidence starts before a context's first navigation.** Clearing logs after load hid start-up JS errors.
- **Assertions poll up to `assertTimeout`.** Lazy routes call their API late; an instant check passed 1/10 on a real app.
- **Snapshot labels are not accessible names.** "Tên ngày nghỉ *" in the snapshot is "Tên ngày nghỉ*" to Playwright, and a combobox is labelled by its value. The recorder marks the executed node (`data-flowctl-target`) and reads Playwright's `ariaSnapshot` first line; recording snapshot labels replayed 0/10.
- **SPAs render after `load`.** `takeSnapshot` waits up to `settleMs` for a first control; an empty snapshot made System 1 answer `BLOCKED`.
- **Password inputs never reach a snapshot** (by design). Login only goes through profiles (`flowctl login`).
- **Dev overlays** (React Query devtools, Vite error overlay) are always filtered (`DEV_OVERLAYS`) on top of `snapshotIgnore`.
- **`DONE` is a stop signal.** It is verified against assertions; three rejections escalate (`done_rejected`).
- **Secrets stay local.** Secret inputs reach System 1 as key names, their values become `***`; other inputs send a `preview`. `decisions.jsonl` stores labels, keys and probabilities, never values.
- **`{{uid}}`** is new per run; the recorder turns values the run expanded from templates (the uid, and every
  `{ value }` input holding a template such as `{{today+1:DD/MM}}`) back into their templates in recorded names,
  so a saved flow replays on another day or env. A date or env value that only appears on the page stays literal.
- **Unknown `{{…}}` is an error** (older flows with a raw `{{…}}` now fail with `flow_invalid`; `findFlowsWithErrors` lets the CLI run the other flows and report that file): write `{{lbrace}}` for a literal `{{`. The recorder escapes names that way; env values are inserted literally and never re-scanned (ADR 0026).
- **A failed navigation commits its error page late.** After a dead page (an empty answer), the crawl waited for a
  `chrome-error:` URL; the URL was already that of the page before, so the wait ended at once and the late commit
  interrupted the next navigation, and every later page read status 0. `observe/walk.ts` waits for this navigation's
  own error-page commit (`framenavigated`) instead.
- **A replay on `shared` reads entries from the store it was given at open time.** `TrustStore.open` snapshots the
  file; a test that saves `destructiveConfirm` entries must open the store again before the replay, or the run sees
  no entry and ends `destructive_blocked`.
- **Ids collide with any number the run saw.** The seen-set takes every digit run, the port of a `127.0.0.1` URL and
  the digits of a `{{uid}}` included, so a small integer id is often `ledger_replay` (fail closed). Fixtures that
  create records use uuid ids (`fixture-app` `/items`).
- **Never deep-compare a Playwright object in a test** (`toEqual` / `toMatchObject` with a `Page`, `BrowserContext`…): the graph is huge and cyclic, the comparison spins synchronously and no vitest timeout can stop it. Compare it with `toBe` and the rest separately.
