# @flowctl/fixture-app

Test-only app for flowctl. Never imported by `src/` of another package, only by tests.

- `startFixture(bug?)` — a two-role leave-request app (employee submits, manager approves) on a random
  port, optionally with one **seeded bug** switched on.
- `startFakeSystem1(script)` — a scripted `/v1/systemone` server so exploration tests never call TypeSafe.
- `FIXTURE_FLOWS_DIR` — sample flows (`leave-approve`, `leave-validation`, `leave-submit`, `leave-persist`) written for this app.
- `/items` — a small items CRUD with uuid ids (`POST /api/items` answers 201 with the id, 409 for a name that
  exists; `GET`, `PATCH` and `DELETE` on `/api/items/:id`) for the run ledger's tests in core; no seeded bug.
- `/echo` — a form that echoes a typed password in the page, the address bar's query, a request body and a
  `\u`-escaped response body (`ECHO_PATH`, `ECHO_PREFILL`), for core's redaction tests; no seeded bug.
- `/lab` — a page with the hard controls (debounced combobox, auto-formatted input, dialog) used by
  snapshot, recorder and exploration tests.

## Seeded bugs

| Mode | Defect | Caught in (flow → assertion) |
|---|---|---|
| `save500` | POST returns 500 | leave-submit → `text` "Đã gửi đơn" (no toast; `network` POST status also fails) |
| `notPersisted` | POST returns 201 but stores nothing | leave-persist → `text` saved reason after reload |
| `wrongBody` | client sends type `OT` instead of `LEAVE` | leave-approve → `network` requestBody |
| `toastOnFail` | POST 500 but the success toast shows | leave-submit → `network` POST status (the toast `text` passes) |
| `noValidation` | empty reason is submitted | leave-validation → `text` "Vui lòng nhập lý do" (first failing; `network` absent also fails) |
| `consoleError` | JS error on load | leave-approve → `noConsoleErrors` |
| `list500` | GET list returns 500 | leave-persist → `text` saved reason after reload |
| `wrongValueAfterReload` | list returns the reason upper-cased | leave-persist → `text` saved reason after reload (case-sensitive) |
| `approve403` | approve returns 403 | leave-approve → `network` PATCH status |
| `approveNoop` | approve returns 200 but status never changes | leave-approve → `text` "Đã duyệt" |
| `redirectWrong` | after submit the URL says `?saved=0`, page content unchanged | leave-submit → `url` |
| `formNotReset` | after submit the reason field keeps its text | leave-submit → `value` |
| `toastInList` | after submit no toast; the success text shows in the list's status column | leave-submit → `text` with `within` |

In the flow each mode is pinned to, it is caught by a failed assertion, not by a step abort. Other flows may
still abort first: in `leave-approve`, `save500`, `notPersisted`, `toastOnFail`, `list500` and
`wrongValueAfterReload` stop at step 6 (approve button not found). `leave-persist` submits as the employee,
reloads and asserts the saved record is visible without using the manager's approve button. Its `network`
POST line and `text` "Chờ duyệt" are not the first failure for any bug today; they are clean-app checks.
The clean app passes all four flows.

After a successful submit the clean app's URL becomes `/requests?saved=1` (`history.replaceState`; the
`toastOnFail` branch does it too). `leave-submit` asserts that.

The accuracy tier (`bun run test:accuracy`, `CAUGHT_BY` in core's `seeded-bugs.accuracy.test.ts`) fails if
any mode is reported `passed`, or if the clean app fails.

## Crawl pages and crawl-class bugs (T2.6)

`/map` is the start page for the crawler (T2.2). It links to the leave-request pages, to `/map/report` and to
`/map/help`, and it holds **decoys** a crawl that stays in scope must never follow or activate (`DECOYS`): an
off-scope path, a popup, a `//host` link, a cross-origin form action, `javascript:` and `data:` links, a redirect
hop to another origin, a subdomain-suffix host, a double-encoded path, a hash route to a denied path, a service
worker registration, a side-effecting GET (`/map/purge` wipes the stored requests) and icon-only destructive
buttons without `aria-label`. No existing page links to `/map`, so flows and snapshots of the leave pages are
unchanged.

Crawl-class bugs (`CRAWL_BUG_MODES`) are found by the free checks of T2.4, not by a flow assertion, so they are
not in `BUG_MODES` or the flow `CAUGHT_BY`; core's `observe-checks.accuracy.test.ts` maps them:

| Mode | Defect | Found by |
|---|---|---|
| `brokenLink` | the "Trợ giúp" link on `/map` points to a page that returns 404 | broken-link check |
| `page500` | `/map/report` returns 500 | no-5xx check |
| `pageConsoleError` | `/map/report` logs a console error | no-console-error check |
| `pageNoAnswer` | the "Trợ giúp" link on `/map` points to `/map/down`, where the server closes the socket with no answer; `/map` also sends a beacon when left, which the crawl refuses and records on `/map/down` | no-unreachable-page check (and no-broken-link from `/map`) |
| `call500` | the summary fetch of `/map/report` (`/map/api/summary`) answers 500 | no-5xx check |
| `call404` | the summary fetch of `/map/report` answers 404 | nothing: a documented non-detection, a 4xx call is not judged (ADR 0033, amendment 2026-11-12) |

`no-broken-link` re-reports the failure of a target page from each page that links to it, so it has no mode of its
own; `brokenLink`, `page500` and `pageNoAnswer` require it next to the target's check.

The T4.9 invariants map to bugs that already exist: create appears and reload keeps (`notPersisted`, `list500`),
round-trip equality (`wrongValueAfterReload`), state change after an action (`approveNoop`), success toast
implies 2xx (`toastOnFail`), the client blocks what the server rejects (`noValidation`), no 5xx (`save500`), no
console error (`consoleError`). The app has no edit or delete, so the "edit shows" and "delete is absent" round
trips have no seeded bug yet.

## Scope guard pages

`/guard` holds pages for core's scope-guard browser tests (`GUARD_PAGES`), unlinked from every other page:
`/guard/downloads` (an export in scope as an attachment and as a `download` link, a `download` link to another
origin, a `data:` export) and `/guard/frames` (a frame in scope, buttons that add a frame on another origin and a
`data:` frame, and one that moves the frame to a denied hash route).

## Contract artefacts (T2.9)

`contracts/` holds what a contract reader (T4.10) parses statically, with values that agree with the app:

| File | Holds |
|---|---|
| `contracts/openapi.yaml` | the API: `/api/requests` (GET, POST), `/api/requests/{id}/approve` (PATCH), `/api/employees` (GET); `NewLeaveRequest` with `reason` 1 to 200 characters, `amount` an integer 0 to 1000000000, `type` `LEAVE` only; each rule's message key in `x-message-keys` |
| `contracts/i18n/vi.json` | every UI message of the leave pages, by key (`request.reason.required` is "Vui lòng nhập lý do") |
| `src/validator.ts` | `LEAVE_REQUEST_RULES` and `validateLeaveRequest`: the server checks every POST with them and the requests page gets the same rules as JSON |

The pages read their messages from `vi.json` (`MESSAGES`), so the text a flow asserts is the text the i18n file
holds. The reason field carries `required maxlength="200"`. A refused POST answers 400 with `{ message, key, field }`.
`type` is declared `LEAVE` but not checked on the server: the `wrongBody` bug breaks that contract on the client and
must still be caught by its `network` requestBody assertion. A test in core (`fixture-contracts.test.ts`) pins the
agreement.

