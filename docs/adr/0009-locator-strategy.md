---
type: ADR
id: "0009"
title: "Locators: testId, then role + accessible name computed by Playwright, must match exactly 1"
status: accepted
date: 2026-10-03
---

## Context

Spike: a recorder using `snapshot.js` labels replayed 0/10, because the label "Tên ngày nghỉ *"
differs from the accessible name "Tên ngày nghỉ*", and comboboxes were named by their current value
instead of their name. The ERP also has comboboxes with no accessible name.

## Decision

**Locators prefer `testId` (per `testIdAttribute`), then `getByRole(role, { name, exact: true })`.
The recorder stores the role/name computed by Playwright itself (mark the acted-on node, then read
`aria_snapshot()`). At replay, a locator must match exactly one visible element; 0 is
`not_found`, >1 is `ambiguous`. Elements without a name are still recorded but reported in
`weakLocators`.**

## Options considered

- **testId → role+name computed by Playwright, exactly 1 match** (chosen): replay finds elements
  the same way Playwright does.
- **Labels from the snapshot**: already available, but the spike showed they differ from Playwright.
- **CSS/XPath**: precise at the moment but breaks as soon as markup changes; unreadable in review.
- **Take the first element on duplicates (like `.first` in POM)**: convenient, but can click the
  wrong thing.

## Consequences

- **Easier:** replay 10/10 on the ERP flow; locators are readable in yaml review.
- **Harder:** the locale must be fixed through the profile because names depend on i18n; apps
  missing accessible names get weak locators (this warning doubles as an a11y finding).
- **Revisit when:** the app changes language often; then `data-testid` should be enforced.

Phase 1 implemented resolving, the exactly-1 match check and `weakLocators`. The recorder belongs to phase 2.
