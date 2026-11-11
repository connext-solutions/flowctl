---
type: ADR
id: "0002"
title: "TypeSafe Jev is the default System 1; Laya is not in v1"
status: accepted
date: 2026-10-03
---

## Context

There are two System 1 candidates using the same `/v1/systemone` protocol: TypeSafe Jev (hosted,
on a waitlist) and Laya (Apache-2.0, self-hosted via `laya-serve`). The user wants to keep the
option to self-host. The Milestone 0 spike measured both on the same harness and the same tasks
(local ERP + TodoMVC).

## Decision

**Use TypeSafe Jev as the default System 1. Laya (the base model and the fine-tune
`cklxx/laya-browser` v19s) is not in v1; it stays only as a possible future backend on the same
protocol.**

## Options considered

- **Jev** (chosen): ERP 18/18 tasks with zero escalations (navigation, dialogs, Radix comboboxes
  selecting a non-default value, date pickers), always the optimal step count, 240–330 ms per
  decision, correct self-reported `DONE` 9/9 on ERP. Trade-off: page data leaves the machine
  ([0005](0005-system1-data-policy.md)), pricing is unclear.
- **Laya fine-tune `cklxx/laya-browser`**: self-hosted, 200–900 ms on M1. But 0/6 real tasks,
  wrong `DONE` 9/9 with high confidence, clicked "Đăng xuất" by mistake. The author reports
  20–26% on multi-step tasks on unfamiliar sites.
- **Base Laya (zero-shot)**: wrong 3/3 on a mock login page.

## Consequences

- **Easier:** v1 has a System 1 that meets the target right away, with no training of our own.
- **Harder:** depends on a service that is on a waitlist; needs a key and a data policy; the key
  was once pasted into a conversation, so it must be rotated.
- **Revisit when:** TypeSafe changes pricing/terms or closes the waitlist; offline runs are needed;
  or there is enough data (the recorded `by: system2` steps) to fine-tune Laya on our own app.
  Switching backends is only a `baseUrl` change ([0003](0003-single-systemone-client.md)).

## Advice

Detailed numbers: spike report (not published) §2, §6. The user
provided a TypeSafe key for the measurements (2026-10-03).
