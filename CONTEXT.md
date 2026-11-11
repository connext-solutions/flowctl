# CONTEXT — flowctl vocabulary

## Domain

- **Flow** — one YAML file in `flowsDir` describing a user journey: profile, start page, inputs, steps, assertions. The single source of truth (ADR 0007).
- **Step** — one action in a flow (`click`, `fill`, `select`, `press`, `goto`, `reload`, …) or a role switch (`as: <profile>`).
- **Assertion** — a deterministic check written before the run: `network`, `text` (optionally `within` one region), `url`, `value`, `noConsoleErrors`. `url` and `network` match only URLs on the run's own origins.
- **Verdict** — `passed` / `failed` / `error` of a run, decided only by assertions (ADR 0004).
- **Run** — one execution of one flow; has a `runId` and a directory under `<flowsDir>/.runs/`.
- **RunSession** — the module that drives one run: contexts per profile, performing steps (`as`, `goto`, actions), snapshots and assertion checks on the active page, hooks, and the order in which `Evidence` collects and saves the run (`core/src/run/session.ts`). Replay and exploration only decide which steps to perform.
- **Profile switch** — an `as` step, optionally with the page that profile opens at (`goto`); written as one YAML entry or as `as` followed by `goto`, it is one step.
- **Evidence** — what a run leaves behind in `<flowsDir>/.runs/<runId>/`: `trace-<profile>.zip`, `final.png`, `network.json` (fetch/xhr calls, plus a `DOWNLOAD` note with `note: download_cancelled` for each download the browser cancelled; assertions never see notes), `console.json`, `decisions.jsonl` (explore and heal), `appmap.json` (observe), `run.json`. A run never saves a download. Safe to share by default (ADR 0030): a `safe` trace has no page content, headers or bodies, and secrets and credential fields are `***`; `--trace full` adds DOM snapshots, cookies and bodies. The `Evidence` module is the only writer of that directory.
- **Profile** — a role with a saved login session (`flowctl login <profile> --env <env>`).
- **Env** — a target deployment (`local`, `staging`, …) with its `baseUrl`; the same flow runs on any env.
- **System 1** — the fast decision model that picks the next operation and element (TypeSafe Jev). It sees only the URL, the title, up to 6,000 characters of visible text and the control labels, with secrets masked; it never sees DevTools data (console, network, storage). Network and console logs are flowctl's, for assertions, evidence and the orchestrator (decided 2026-11-11, issue #9): a model that reads response bodies would need their redaction too, and a verdict never rests on what a model saw (ADR 0004, 0005).
- **System 2 / orchestrator** — the coding agent (Claude Code, Codex) that gives goals and resolves escalations.
- **Escalation** — System 1 handing a step back to the orchestrator (blocked, low confidence, loop, DONE rejected).
- **Exploration** — System 1 discovering a new flow and recording it.
- **Control** — an operable element in a page snapshot, with an id that is stable per page; escalations list them as `[id] role "name"`.
- **Recording** — the steps an exploration executed; saved as a flow only after a confirming model-free replay passes.
- **Directed step** — a step the orchestrator gives during an exploration (`by: system2`), possibly naming a control id.
- **Replay** — re-running a recorded flow with no model.
- **Heal** — fixing a broken locator during replay by asking System 1 for that one step; never touches assertions; opt-in (`--heal`).
- **Seeded bug** — a switchable defect in `fixture-app` that a correct run must report as `failed`; measures accuracy.
- **Observe / crawl** — mapping an app without a model: breadth-first from one start path, following only same-window links in the `visit` scope whose label and path do not look destructive, never clicking, typing or submitting; only reads leave the browser, on every env class, and every WebSocket is closed (ADR 0033). Not guarded: a side-effecting `GET` whose path holds no destructive word, and an action carried in a query (a GraphQL mutation in a `GET`). Early.
- **AppMap** — what a crawl saw, written as `appmap.json`: per page its path, document status, title, snapshot controls, forms with their field model, same-origin links, fetch/xhr calls, console errors and `refused`. Paths only, no query, values or bodies (`core/src/observe/schema.ts`).
- **Page (of a crawl)** — a path on the env's origin; the query string and fragment are not part of it, so a hash route is the page it sits on (ADR 0033).
- **Refused (on a page)** — a request the scope guard (`scope_violation`) or the crawl's read-only request layer (`destructive_blocked`) stopped before it was sent while that page was open; in a crawl it is an observation, not the end of the run. A request the guards only detect after it was sent ends the crawl, as in any run (ADR 0033).
- **Weak locator** — a recorded locator with neither test id nor accessible name; reported in `weakLocators`.

## Trust

- **Trust store** — the per-machine, owner-controlled `~/.config/flowctl/trust.json` (ADR 0025): env classes, production origins, the project and its flows root, hook consents; repo files can only narrow it. `flowctl trust init` creates it.
- **Owner key** — the passphrase-protected Ed25519 key in `~/.config/flowctl-owner-key` that signs store entries; its fingerprint is pinned in the store.
- **Env class** — `production`, `shared` or `local`, typed by the owner for each env; the destructive-action guard and System 1 rules read it.
- **Guarded command** — a command that refuses with `trust_missing` before any side effect when the store, the project or its flows root is missing; every command except `--help` and `trust init`, and every MCP tool (`COMMANDS` in core).
- **Hook** — a flow's `setup`/`teardown` shell text; it runs only with a consent from the store (ADR 0021).
- **Closure** — the files a hook can read or run under the flows root, found by statically judging its commands; the consent digest covers the hook text and every closure file.
- **Uncovered** — a command or argument the closure judge cannot decide (an interpreter with `-c`, an unknown program, a computed path); listed at consent, refused in a store marked `ci`.
- **Hook snapshot** — the private, read-only copy of the closure files under `/tmp` that a consented hook runs from, re-verified before each run.
- **Digest** — a sha256 over canonical JSON with a `purpose`: `hook` (consent to run hooks), `confirm` (a destructive confirmation, ADR 0024 section 5) and `classify` (classing a hand-written flow). One never stands in for another.
- **Destructive action** — a click, select or Enter on a control named like delete, approve, reject or pay; on a `shared` env only the orchestrator may take it, with `allowDestructive`, and never on `production` (`ActionGuard`, interim part of ADR 0024 section 5).

## Error kinds

| Where | Kind | Meaning (what to do) |
|---|---|---|
| Run `error` | `app_unreachable`, `profile_expired`, `setup_failed`, `system1_unreachable` | Infrastructure: start the app, `flowctl login`, check the key or network, fix the hook. Never a product bug |
| Run `error` | `flow_invalid` | The flow or request: bad YAML or template, or a navigation off the env origin |
| Run `error` | `system1_not_allowed` | The env is not in `system1.allowedEnvs`, the trust store does not class it `local` or `shared`, or the store's `system1` section does not allow the env, the endpoint host or the key variable (`flowctl trust add system1`) |
| Run `error` | `hooks_untrusted` (reason `no_entry`, `digest_mismatch`, `hook_uncovered`, `hook_env_unsafe`) | Hooks without a matching consent: `flowctl trust hook <name>` |
| Run `error` | `scope_violation` | The run reached, or tried to reach, something outside its scope: another origin, a production host, a denied path (`/logout` is always denied), a path outside `target.scope.allow`, a frame or download from outside the scope, a `data:` or `blob:` frame. The request was aborted where the browser let flowctl stop it; the hint names the URL and the command that widens the scope (`flowctl trust add origin <env> visit|call <origin>`) |
| Run `error` | `destructive_blocked` | An exploration on a `shared`, `production` or unlisted env sent a request that looks destructive (any `DELETE`, or a path with a word such as `delete`, `approve`, `purge`, `xoá`, `duyệt`), and flowctl stopped it before it left the browser. No verdict stands on such a run: start it again with `allowDestructive: true` (shared envs only) and take that step as the orchestrator, when the user asked for that action, on data the run created |
| Run `error` | `budget_exceeded` | The run took longer than its wall-clock budget (`target.budgets.wallClockMs`, at most 10 minutes, the default) and was stopped mid-step: raise the budget or split the flow. Escalation waits count, since it is wall-clock time |
| Run `error` | `env_not_trusted` | The env is not in the trust store, its `baseUrl` or `loginUrl` is on another origin than the store records, or a command without `--env` has no trusted default: `flowctl trust add env <env>`, or restore the config |
| Run `error` | `env_not_allowed` | A flow `{ env: NAME }` input whose name is not in the trust store's allowlist for the flow's profile (or no store): `flowctl trust add profile <profile> <NAME> secret` |
| Run `error` | `internal` | A flowctl bug or a crashed browser |
| Step failure | `not_found`, `ambiguous`, `action_failed` | A step could not run (replay `failed`, exploration escalates) |
| Exit 3 (trust) | `trust_missing`, `trust_tampered` (log details `log_doc_mismatch`, `log_missing` (also a store made before the log: make it again with `trust init`), `log_head_mismatch`, `log_chain`, `log_genesis`: trust.json or trust.log was changed outside flowctl; `rotate_state`: the files match no step of a rotation; `owner_key_mismatch`: the unlocked key is not the pinned one; `anchor_unreachable`, `anchor_head_mismatch`: the second copy of the head in the keychain or `--anchor-dir` is gone or names another version, so the store was rolled back or replaced), `project_not_trusted` (detail `identity_mismatch`: another history at the registered path; `no_identity`: an entry from before identity, run `flowctl trust add project`), `identity_unverifiable` (not a git checkout with full history), `store_unreadable`, `store_busy` (another flowctl command holds the store lock or changed it meanwhile: run again), `anchor_unavailable` (`trust init` found no keychain: pass `--anchor-dir`), `rotate_unverified` (an entry the current owner key does not verify, or a section rotation cannot re-sign yet: nothing changed), `rotate_incomplete` (an owner-key rotation was interrupted: run `flowctl trust key rotate-owner` again), `replace_unverified` (the old store does not verify, so `trust init --replace` cannot run: remove it by hand and run `flowctl trust init`), `store_replaced` (the store was replaced by `trust init --replace`; if the swap was interrupted, the message lists the renames that finish it), `store_exists`, `store_writable_in_ci`, `platform_unsupported`, `trust_entry_invalid`, `tty_required`, `confirmation_mismatch`, `key_*` | The trust store refused; the message names the command that fixes it. `passphrase_too_short` exits 2 |

Kinds that ADRs 0020, 0024 and 0025 specify but no code raises yet (`root_not_trusted`, `ledger_*`, `provenance_*`, `bundle_*`) are listed in ADR 0025 Amendment 2026-11-02 section 8.

## Design (from `mattpocock-skills:codebase-design`)

- **Module** — anything with an interface and an implementation (a function, a folder, a package).
- **Interface** — everything a caller must know: signatures, invariants, error modes, ordering. Here: a package's or folder's `index.ts` plus its documented behaviour.
- **Seam** — where an interface lives and behaviour can change without editing callers. Example: `RunSession`.
- **Adapter** — a concrete thing filling a seam. One adapter is a hypothetical seam; two make it real.
- **Depth** — behaviour available per unit of interface learned. Deep: `RunSession`, `verify`. Avoid shallow pass-throughs.
- **Leverage / Locality** — what depth gives callers (more per call) and maintainers (changes in one place).
