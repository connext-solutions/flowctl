---
type: ADR
id: "0003"
title: "One HTTP client for the /v1/systemone protocol, no interface"
status: accepted
date: 2026-09-29
---

## Context

The user wants an abstraction layer to switch between Jev and Laya. The spike confirmed that
`laya-serve` speaks the same `POST /v1/systemone` protocol as TypeSafe; the protocol is a shared
API for questions with predefined answers (`choice`/`score`), and the "browser agent" part lives
in the client.

## Decision

**There is only one HTTP client; the "abstraction" is the config `system1: { baseUrl, apiKeyEnv,
confidenceThreshold, allowedEnvs }`. Split out an interface only when a backend appears that is
not protocol-compatible.** The client declares the action list dynamically, including `PRESS_ENTER`.

## Options considered

- **One client + baseUrl** (chosen): least code; switching backends needs no code change.
- **`System1Backend` interface + 2 adapters**: more flexible on paper, but the two adapters would be
  identical because the protocol is the same.

## Consequences

- **Easier:** adding a backend on the same protocol (self-hosted Laya, our own fine-tune) is only a
  config change.
- **Harder:** a backend with a different protocol will need a small refactor to split out the
  interface.
- **Revisit when:** a backend needs its own behavior (batching, streaming, auth other than Bearer).
