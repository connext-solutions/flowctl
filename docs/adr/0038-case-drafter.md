---
type: ADR
id: "0038"
title: "The case drafter writes only grounded steps from fixed verb rules; the rest is a gap"
status: accepted
date: 2026-11-12
---

Decided under the owner's delegation of 2026-11-11.

## Context

After the matcher (ADR 0034) has joined a spec `Operation` to a screen of the `AppMap`, Derive drafts a test case
for it (roadmap section 3.4, task T4.2). Teams that write manual test cases already follow a step template: every
step is numbered, says who acts, does one thing, names each control by its exact label in quotes, and does not
exist only to look at something (looking belongs to the expected result). A reviewer rejects steps that break
these rules, and part of the template is mechanical enough for a script to check.

A drafted step is later executed by a run (directly or as an exploration goal). A step drafted against a label
that is not on the screen, or a value copied from spec text, fails for the wrong reason or carries provider text
into a flow. Spec text is untrusted data (ADR 0023, provider input hardening), and the verdict must not depend on
what a generator guessed (ADR 0004, ADR 0020). This ADR covers steps only; expected results and their assertions
are task T4.3.

## Decision

1. **Shape.** `draftCase(op, match, map, { actor?, verbs? })` returns a `CaseDraft`
   `{ operation: { id, provider, ref }, screen, steps, status: 'unverified', gaps, observed }`. A `DraftStep` is
   `{ n, actor, action, target?, input?, via?, page?, source }`: `action` is `open`, `click`, `fill`, `select` or
   `check`; `target` is `{ role, name, pointer }`, the role and name as the map holds them and the JSON Pointer of
   the element in `appmap.json`; `input` is a reference to a step input; `via` is a menu path of navigation labels;
   `page` is the page an `open` reaches; `source` is the span of the operation's text the step comes from. `actor`
   is display text from the spec (or the caller): a caller that runs the step maps it to a profile through its own
   table, and never uses it as a profile name, a file name or a path. Code in `core/src/derive/draft/`; pure, no
   model, no I/O.
2. **Fixed verb rules.** A verb table (`VerbRules`) lists, per action and for observing, the words that introduce
   it. The English table is the default; a caller drafting from spec text in another language passes its own. In a
   normalised step (ADR 0020 section d), verbs are found at token boundaries, case-insensitive, and only outside
   quoted labels (the same `quotedSpans` the matcher uses): in `click "Go to settings"` the only verb is `click`. At
   one place the longer word wins (`check that` observes, `check` ticks). Each quoted label of the step belongs to
   the last verb before it. The table may also list negation words (`negate`; English: `do not`, `don't`, `never`,
   `not`), found the same way. Planning is linear in a step's verbs, quotes and mentions: each quote gets its verb
   in one merge pass over the two sorted lists, and the match entry's spans are grouped by step once.
3. **Grounding.** A label after `click`, `fill`, `select` or `check` becomes one step on the one element of the
   matched screen that the match report says it equals (ADR 0034 rule 4) and whose role can take the action (a
   fixed role table per action). A form field and a control with the same role and name count as one element. A
   label after `open` is a menu path label when it equals a navigation control (`link`, `menuitem`, `tab`,
   `treeitem`) on any page, else the page whose title it equals (`open the "Settings" page`), or an address when it
   starts with `/` and names a page. An `open` with no quoted label reaches the one page whose title its words
   mention outside quotes (ADR 0034 `title-mention`). The page of a menu path is the one page whose title equals
   its last label, else none. `select` takes a `combobox` or `listbox`; a `select` whose label is none of those but
   one `radio` or `option` of the screen picks that choice, so it is drafted as a `click` on it, with no input.
4. **Gaps, never guesses.** A spec step goes to `gaps`, whole and with its spans, when any part of it cannot be
   grounded: no verb before a label (`no_verb`), an action verb with nothing quoted (`unquoted`), a negation word
   between the verb before an action verb (or the step's start) and that verb (`negated`: `do not click "Save"`; a
   negation in an observing clause right before an action verb also counts, failing closed), a second quote after a
   `fill` or `select` verb (`quoted_value`, below), a label found nowhere, only on other pages, on the screen with
   the wrong role, more than once on the screen, or refused by the Unicode rules (`label_not_found`,
   `label_not_on_screen`, `role_mismatch`, `ambiguous`, `refused`). With no
   single matched screen every step is a `no_screen` gap. With no actor (the caller's, else the operation's, not
   refused) the draft has no steps and one `no_actor` gap. Dropping one action of a step and keeping the others
   would draft a different case, so a step is all or nothing.
5. **Observing is not a step.** A step whose verbs all observe, and the part of a step from an observing verb to
   the next verb, go to `observed` with their spans, for the expected results (T4.3).
6. **Values are inputs.** Every `fill` and `select` gets a fresh input reference (`input-1`, `input-2`, … in step
   order). A `fill` or `select` verb takes exactly one quoted label; any further quote it governs is a value
   (`type "Amount" "50"`), so the step is a `quoted_value` gap that keeps the value's span and never stores the
   value. No quoted value and no other provider text becomes an input name, a value, a key or a path (ADR 0023
   rule 1; ADR 0006: values come from the orchestrator).
7. **The step lint.** `lintSteps(steps, map)` checks the mechanical rules of the template on drafted or hand-edited
   steps and returns typed problems in step order: `numbering`, `no_actor`, `observe_only`, `unknown_action`,
   `missing_target`, `ungrounded_target` (the pointer does not hold that role and name), `role_mismatch`,
   `ungrounded_via`, `ungrounded_page`, `input_literal` (an input that is not a flow name, so it may be a value; a
   value that happens to be a flow name passes), `missing_input`, `unexpected_input`, `misplaced_field` (a `via` or
   `page` on a step that does not open, a `target` on one that does), `duplicate_step` (equal to the step right
   before it). `duplicate_step` is a hint on consecutive steps only; two drafted `fill` or `select` steps are never
   duplicates, since each has its own input reference. A draft lints clean against its map, except
   `duplicate_step` where the spec repeats an action; an empty list is not a review.
8. **The renderer.** `renderSteps(draft, phrases)` writes `N. <phrase>` lines from a phrase table (English by
   default, a caller's in another language), joined with `\n`, in one replacement pass. A control name, page or menu
   label enters through `quoteValue`: cut at 500 code points, invisible and control code points (line breaks
   included) shown as `⟨U+XXXX⟩`, and so are `"`, `“`, `”` and `\` (no backslash escaping, which `quotedSpans` would
   not understand), inside `"…"`. The actor is written bare when it is a plain flow name (`staff`), else through
   `quoteValue`; the input reference is written `⟨input-1⟩`, and a step whose reference is not a flow name is a
   `ConfigError`. A value cannot close its quote for a reader or a re-parser, add a step line, reorder text with a
   bidi control, or be read as a placeholder. A table whose phrase misses a placeholder it needs, names another
   one, or holds an invisible code point (a line break included), or whose separator holds one, a placeholder, a
   quote mark or `\`, is a `ConfigError`. The output is plain text; a markdown surface escapes it again (`mdCode`).
9. **Status.** A draft is always `unverified`: a person reviews it (ADR 0020 section f), and only a confirming run
   makes it a flow.

## Options considered

- **Fixed verb rules plus the match report** (chosen): every step points at a span of the spec and an element of the
  map, and the same inputs give the same draft.
- **A model maps step text to actions.** Handles paraphrase and verbs a table lacks, but the step would be model
  judgement nobody can reproduce, and a wrong control would make a case fail for the wrong reason. Rejected for the
  core drafter; a model may later propose a step, recorded as a proposal.
- **Keep the grounded part of a partly grounded step.** Gives more steps, but a case missing a `fill` is another
  case. Rejected: the step is a gap, and a person splits it or fixes the spec.
- **Use a quoted value as the fill value.** Saves an input, but copies provider text into a flow and lets a spec
  edit choose what is typed. Rejected (ADR 0023 rule 1); a quoted value that is no label makes the step a gap.
- **Verb words in core for each language.** Would put product language into core and grow without bound. Rejected:
  the caller passes its table, as it passes its phrase table.
- **Lint the rendered text.** Works on hand-written cases too, but needs per-language parsing of quotes and actors.
  Rejected for core: the lint reads the structured steps, so it is the same in every language.

## Consequences

- **Easier:** a reviewer sees, for each step, the spec span and the map element it came from, and for each gap why;
  a team writes its cases in its own language with its own phrase and verb tables; the lint gives hand edits the
  same checks as drafts.
- **Harder:** paraphrased steps (`press the submit button` without quotes), labels shown only after an action (a
  dialog's buttons, which a read-only crawl does not see), and steps on a page other than the screen become gaps.
  A quoted fill value (`type "50" into "Amount"`) makes the step a gap: `label_not_found` when the value comes
  first, `quoted_value` when it follows the label. The
  drafter writes no "prepare data" or "clean up" steps, and adds no `open` step the spec does not have.
- **Revisit when:** measured drafts on real specs show most gaps come from quoted values or from labels on a second
  page (then ground per page after a navigation, with the drive stage's map, T2.8), or a team's template needs a
  rule the lint lacks.
