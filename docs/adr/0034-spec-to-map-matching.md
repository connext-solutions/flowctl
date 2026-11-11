---
type: ADR
id: "0034"
title: "Derive matches spec operations to the AppMap by fixed text rules, with evidence, and never breaks a tie"
status: accepted
date: 2026-11-12
---

## Context

Derive (roadmap section 3.4) starts by finding, for each spec `Operation` (ADR 0023), the screen it happens on and
the controls its steps name, in the `AppMap` of a crawl (ADR 0033). Later stages build on that join: the case
drafter writes steps against the matched controls (T4.2), and the conflicts file lists where the spec and the app
disagree (T4.4). A wrong join is invisible later: a step drafted against the wrong page fails for the wrong reason,
and a conflict that is not reported hides a spec drift. So the join must be checkable by a person, give the same
answer every time, and say "I do not know" instead of guessing.

ADR 0020 already fixes how spec text is compared with an expected value (section d: NFC, ASCII whitespace
collapsed, Unicode refusals; amendment 2026-11-12: token boundaries). The matcher compares spec text with page text,
which is a different pair of inputs, and needs its own rules for which strings take part and how close is close
enough.

## Decision

1. **Inputs and output.** `matchOperations(operations, map)` is a pure function, no model, no I/O. It returns per
   operation the candidate screens (pages with a score and the evidence of each match), every quoted literal with
   the map elements it equals, and the steps nothing matched (`MatchReport`, `core/src/derive/match/`).
2. **Every match is grounded.** Each evidence entry cites a span of the operation's text (a path into the
   `Operation`, such as `['steps', 1]`, and UTF-16 offsets into that string after normalisation) and one element of
   the map (a page by path, its title or path, or a control or form field by index, with its name as the map holds
   it). Nothing in the report is text the matcher made up.
3. **Normalisation and refusals are ADR 0020's.** Both sides are normalised as in ADR 0020 section d (NFC, ASCII
   whitespace runs collapsed and trimmed). A string is refused, and matches nothing, when its NFKC form differs from
   its NFC form, when it holds a code point of category `Cc`, `Cf`, `Cs`, `Zl`, `Zp`, `Co`, `Cn` or a default-ignorable
   code point, or a decimal digit outside ASCII. The rule applies to the two strings being compared (the quoted
   literal, the page title, the control or field name), not to the sentence around a literal. A refused literal is
   reported with its reason; a refused map element is listed in `refusedElements`. NFKC is never used to fold.
4. **One fuzzy rule, the case fold.** Two strings are `exact` when they are equal after normalisation, `folded` when
   they are equal after lower-casing (Unicode default case mapping, locale-free) and dropping a trailing run of
   spaces, `*` and `:` (a required marker or a label colon). Nothing else is fuzzy: no edit distance, no substring,
   no accent folding. An empty string never matches.
5. **Evidence kinds and weights.**

   | Kind | Spec side | Map side | Comparison | Weight |
   |---|---|---|---|---|
   | `title-equal` | the operation title, a heading of an expected item's context | page title | rule 4 | 3 |
   | `path-literal` | a quoted literal in a step or expected item that starts with `/` | page path | the literal cut at `?` or `#`, equal | 3 |
   | `title-mention` | the operation title, a heading, a step | page title | occurs at token boundaries (ADR 0020 amendment 2026-11-12 section 2), case-insensitive | 2 |
   | `label` | a quoted literal (`"…"` or `“…”`) in a step or expected item | control or form field name | rule 4 | 2 |
   | `doc-segment` | a folder of `location.ref` (`map/pages.md` gives `map`) | first segment of the page path | rule 4 | 1 |

   `title-mention` is not counted for a spec string that already gives `title-equal` with that page. For the matcher
   an invisible code point (as refused in rule 3) next to a title is not a token boundary, so a hidden character
   cannot make a mention; and the mention compares lower case per code point where rule 4 lower-cases the whole
   string (they differ where one code point lower-cases to several (İ), or where the mapping depends on context). Expected items
   give literals only: an outcome may mention another page ("the Report page opens"), so its unquoted text is not
   route evidence.
6. **Score.** A page's score is the sum of the weights of its distinct evidence, where evidence is distinct by kind
   and folded matched value (the literal for `label` and `path-literal`, the element name for the others): a title
   equal to three headings adds 3, not 9; `"Gửi"` and `"gửi"` quoted in two steps add 2 once. Roles are reported,
   not scored.
7. **Verdict.** The page with the top score is the operation's screen (`matched`). When two or more pages share the
   top score the verdict is `ambiguous` with all of them, and none is picked; when no page has evidence it is
   `none`. A tie is never broken by order, path or role.
8. **Unmatched steps.** A step is listed when no evidence cites it, or when it quotes a literal that equals no
   element on any page (`missing`). Whether a literal is on the matched screen or only elsewhere is left to the
   conflicts output. A quoted address that names another page than the screen is not a conflict: an action may lead
   there.
9. **Determinism.** Operations are sorted by id, provider and ref (then by their content, for duplicates);
   candidates by score, then path; literals by text; evidence and elements by kind, spec path, offsets, page, element
   kind and index; strings by UTF-16 code units. The same operations and map give the same report in any input
   order.
10. **Conflicts for a person, not a verdict.** `findConflicts(report)` turns a report into spec ≠ app disagreements
    (`page_missing`, `page_ambiguous`, `label_not_on_screen`, `label_not_found`, `path_not_found`,
    `expected_not_observed`, `text_refused`); `writeConflicts` writes them as `conflicts.md` and `conflicts.json`
    inside a given root (`ensureDirInside`, no symlinks). In the markdown, every untrusted string (spec text, page
    paths, ids) is one code span fenced longer than its longest backtick run, so no HTML, link, heading or emphasis
    renders; invisible, control and lone surrogate code points are shown as `⟨U+XXXX⟩`; a leading `=`, `+`, `-` or
    `@` (or its fullwidth form) gets a `'`
    so a pasted cell is not a spreadsheet formula. In the JSON, every invisible or control code point is a `\u`
    escape. A conflict never changes a verdict and never becomes a flow.

## Options considered

- **Fixed text rules with evidence** (chosen): every answer can be checked by reading two strings; the weights are
  few and visible; a tie says so.
- **Edit distance or token-set similarity on labels.** Finds `Gửi đơn` for `Gửi`, which is the wrong button as often
  as the right one, and the threshold becomes a tuning knob nobody can review. Rejected; a second rule can be added
  with its own evidence kind if measurements ask for it.
- **A model picks the screen.** Handles paraphrase, but the join would be model judgement that later stages and
  reviewers cannot reproduce. Rejected for the core matcher; a model may later propose a candidate, recorded as such.
- **Break ties by map order or by the role of the matched control.** Always gives an answer, and the answer depends
  on crawl order or on a guess about what a step means. Rejected: `ambiguous` goes to a person.
- **NFKC folding of both sides.** Matches `ﬁle` and `file`, and fullwidth letters; ADR 0020 refuses these in quotes
  for the same reason (a look-alike must not pass for the reviewed text). Rejected.

## Consequences

- **Easier:** the case drafter gets screens and controls it can cite; the conflicts file can say exactly which quoted
  label is not on the screen; a reviewer can check any match in the source and the map.
- **Harder:** paraphrased specs ("bấm nút gửi" without quotes) give no label evidence; a spec that names its screen
  only in a paragraph outside the steps and headings gives none either; pages that share a title tie. A read-only
  crawl holds titles, controls and fields, not messages, so an expected message is never matched until the drive
  stage (T2.8) records page text after an action.
- **Revisit when:** measured accuracy on more spec sources shows that labels are commonly paraphrased, a provider
  carries screen ids that should outweigh text, or the drive stage adds observed messages to the map.
