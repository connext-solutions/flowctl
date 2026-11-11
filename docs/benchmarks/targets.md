# Targets for spec-driven testing

Measurable exit criteria for phases P2 to P6 of the roadmap. Measured on `fixture-app` (ten seeded bugs
today, more after tasks T2.6 and T4.9) by the accuracy tier (T4.7). A target that is missed is reported
with its number; it is never reached by loosening a check. Set 2026-10-29 (task T0.8), revised after review.

## Layers

Detection is measured in three cumulative layers. The accuracy tier runs all three, and each run states
which sources were enabled:

| Layer | Sources enabled |
|---|---|
| L1 | No spec, no contract artefacts: invariants and free checks only |
| L2 | L1 plus contract artefacts (OpenAPI, shared validator, i18n file) |
| L3 | L2 plus the markdown spec |

Each layer may add detections and may not lose any the previous one made.

## Outcomes

A case ends in one of these outcomes, used by every target below:

- `passed` and `failed`: verdicts from assertions (ADR 0004);
- `smoke-only`: all assertions are free checks (ADR 0020);
- `unverified`: a draft not yet through the review gate (ADR 0020);
- `needs-review`: the case could be derived but an expectation needs a spec or contract that is not
  enabled; it is reported, never run as pass or fail, and counts as **not detected**.

## Targets

| # | Target | Measured by | Phase |
|---|---|---|---|
| 1 | L1 seeded-bug detection: **>= 7 of 10** | Accuracy tier, one run per bug | P4 |
| 2 | L2 detection: **>= 8 of 10** | Same, contracts enabled | P4 |
| 3 | L3 detection: **10 of 10**, each traced to a `sourceRef` of the expected kind (table below) | Same, spec enabled; a script checks the kind of the failing assertion | P4 |
| 4 | **0 failed verdicts on the clean app over >= 30 runs.** Smoke bound: 0 of 30 gives a 95% upper bound of about 10% on the false-positive rate (rule of three: 3/N). Flaky runs are counted as failures, not retried away | Accuracy tier, all bug flags off | P4 |
| 5 | **0 passed verdicts across the 10 bugs x 3 runs matrix at layer L3.** The bound is weak: 0 of 30 is an upper bound of about 10% on the miss rate. Layers L1 and L2 are held to targets 1 and 2 only, since they are expected to miss bugs. Raise N to 100 runs before any claim of a rate | Accuracy tier, 30 runs at L3 | P4 |
| 6 | **100%** of derived assertions have a resolvable `sourceRef`, and **0** literals that are not derivable from their source. "Derivable" means passing the ADR 0020 comparison rules (whole-item equality with a signed positive polarity, parsed numbers with units, contract equality from a static read, template equality). A negative test seeds a wrong literal (a number inside a longer number, a word inside a negation) and the script must reject it | Mechanical script over all derived flows | P4 |
| 7 | Crawler covers the fixture-app's **5 routes** with **0 scope escapes**, with all of these decoys in place (the list of T2.6): an off-scope link, a popup, a `//host` link, a cross-origin form action, a `javascript:` link, a `data:` link, a redirect hop to another origin, a subdomain-suffix host, a double-encoded path, a hash route to a denied path, a service worker registration, a side-effecting GET, and icon-only destructive controls without `aria-label` | Observe test against fixture-app | P2 |
| 8 | **Cost and time per case** recorded in `run.json` for every driver; budgets per case set after the first measurement | `run.json` fields from T5.5 | P5 |
| 9 | Failure classifier agrees with human labels on **>= 80%** of the labelled corpus (20 failures) | Labelled corpus, private | P6 |

## Security targets

| # | Target | Measured by |
|---|---|---|
| S1 | Injected text in a spec, sheet or issue yields **0 destructive steps** and **0 `env:` inputs** in derived flows | Hostile fixtures per adapter (ADR 0023) |
| S2 | A `sourceRef` with a traversal path, an absolute path or a symlink out of the root is rejected | Hostile fixture for contract and spec resolution |
| S3 | The outgoing driver request contains **0** seeded secrets (page title, URL, label, request body, response body) | Driver contract test (T5.4) |
| S4 | A login run leaks **0** secrets across all evidence types: `run.json`, `decisions.jsonl`, network and console logs, traces, screenshots, error messages, in plain and encoded forms | Redaction test (T1.5) |
| S5 | Baselines and agent-authored specs are reported **separately** from human-authored spec, contract and invariant detections | Report check (T4.7, T7.1) |
| S6 | **Origin forgery, including a store redirected by environment or `HOME`:** a pull request that adds a login origin, renames an env or edits `baseUrl` in the repo changes nothing the store trusts: **0 credentials typed**, **0 requests** on a production origin, at every redirect hop | Hostile config fixtures against a store (T1.4, T1.2) |
| S7 | **Production relabelled:** a repo that labels a production origin as `shared` or `local` is still blocked | Same |
| S8 | **Trust store absent, unreadable, tampered, redirected or inside the repo:** every guarded action ends `trust_missing`, `trust_tampered`, `trust_store_in_repo` or an equivalent refusal; **0** actions proceed. Includes a store pointer moved by `FLOWCTL_TRUST_DIR`, `XDG_CONFIG_HOME`, `HOME` or a bare flag without a registered marker, which must be ignored or refused, and a process with no passwd entry, which must be refused | Trust-store tests (T1.0) |
| S9 | **Baseline tamper and re-bind:** changing the value, the evidence summary, the flow id or the assertion binding of a signed baseline, or moving it to another flow, is rejected; a baseline signed by a key not in the store is rejected | Signature tests (T4.5) |
| S10 | **`stale_sourceRef`:** after the spec, the contract file or the provider revision changes, `check` re-runs the full comparison and reports it; **0** silent passes | `check` test (T4.14) |
| S11 | **Approval without a TTY:** an approval attempted over MCP, a pipe or a redirected stdin is refused; a same-user pseudo-terminal attempt is documented as out of scope, not claimed as blocked | Approval tests (T4.5) |
| S12 | **Vacuous `absent`:** an `absent` assertion on a native form post or a document navigation (not observable by `network`), with no action step, an action after the assertion, a disabled or hidden control, a preceding failing step, or evaluation before the request window settles is refused | Vacuity tests (T4.3) |
| S13 | **Comparison negatives:** a truncated quote, a quote containing a zero-width or bidirectional control character, an item without a signed positive polarity, an item in a language other than the store's, a negated item, a number from the wrong field, a number with a different unit or locale: **all rejected** | Negative corpus for the target 6 script (T4.7) |
| S14 | **Secret reaches a driver or a login surface:** covered by S3 and S4, plus session tokens in `Set-Cookie`, `Authorization`, and bearer values in responses, and the username masked | T5.4, T1.5 |

## Per-bug expectations

The ten seeded bugs and what is needed to catch each. "Zero-expected-value" means the check needs no
knowledge of what the app should show.

| Bug | Class | Caught by | Needs | Layer |
|---|---|---|---|---|
| `consoleError` | zero-expected-value invariant | no console errors | nothing | L1 |
| `list500` | zero-expected-value invariant | no 5xx on a read | nothing | L1 |
| `save500` | zero-expected-value invariant | no 5xx on a write | nothing | L1 |
| `toastOnFail` | zero-expected-value invariant | success toast implies 2xx | nothing | L1 |
| `notPersisted` | round-trip equality | created or edited value appears after reload | a driven action (T2.8) | L1 |
| `wrongValueAfterReload` | round-trip equality | value read after reload equals value typed | a driven action (T2.8) | L1 |
| `noValidation` | client blocks what server rejects | client accepts an input the server answers 4xx to | the 4xx probe, else a validator in code or a spec sentence | L1 if the probe finds the 4xx, else L2 |
| `wrongBody` | needs contract or spec | request body matches the declared shape | OpenAPI or a spec sentence | L2 |
| `approveNoop` | needs spec for exact semantics | state changes after the action; the exact new state needs a spec | spec for the exact state; without one the outcome is `needs-review` | L3 |
| `approve403` | needs spec for exact semantics | allowed role gets 2xx; which role is allowed needs a spec | spec for the role matrix; without one the outcome is `needs-review` | L3 |

Reading the table against the targets: the six invariant-class bugs plus `noValidation` through the 4xx
probe give the **7** of target 1; `wrongBody` joins at L2 for **8**; `approveNoop` and `approve403`
complete **10** only with a spec (L3). If the probe does not find the `noValidation` 4xx, L1 detects 6, and
target 1 is missed and reported as such.

## Out of scope for these targets

- Business correctness beyond what the markdown spec states.
- Apps other than fixture-app and the private corpus; the numbers say nothing about them until measured.
