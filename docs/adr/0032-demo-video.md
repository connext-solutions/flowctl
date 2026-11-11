---
type: ADR
id: "0032"
title: "Demo videos: an opt-in replay recording with a step overlay that assertions cannot see"
status: accepted
date: 2026-11-11
---

## Context

People ask coding agents for a video of a flow: to show a feature in a pull request, to attach a repro to a
ticket, or to prove a fix. Recording a screen by hand, or driving a browser from an agent with a screencast tool,
gives a video with no context: the viewer cannot tell which step is running or what the result was, and the
agent's own fumbling ends up in the clip. A saved flow already holds the exact steps, and a replay is
deterministic and model-free.

Two existing rules constrain a video. Evidence must be safe to share by default (ADR 0030): a video shows
everything the pages show and cannot be masked like `final.png`. A verdict comes only from assertions (ADR 0004):
anything flowctl adds to the page must not change what an assertion or a locator sees.

## Decision

1. **`flowctl replay --video` and `flow_replay` with `video: true`** record one video per profile with Playwright
   (`recordVideo`, 1280×800) into the run directory as `video-<profile>.webm`, listed in `evidence.videos`. Off by
   default; the CLI prints a warning that the video shows everything on the pages. Exploration does not record:
   only a saved flow, whose steps are known and reviewed, becomes a video.
2. **A step overlay.** An init script draws a box (bottom right: the flow name, then `Step n: <action>` before each
   step, then `Result: passed` or `failed: <assertion>` or `error: <kind>`) and a fake cursor that glides to the step's
   target. The text names the action, the target's locator and an input's **key**, never a typed value. Each step
   waits 0.9 s before it acts and the result stays 2.5 s, so a viewer can read it; a run without a video has no pause.
3. **The overlay is invisible to the run.** It lives in a closed shadow root under a host on `<html>` (outside
   `<body>`), `aria-hidden`, with `pointer-events: none`, and its host tag is in `DEV_OVERLAYS`: `body.innerText` (the
   `text` assertion), Playwright locators (they pierce only open shadow roots), the accessibility snapshot and the
   System 1 snapshot never see it. Text is set with `textContent` and call arguments are JSON literals.
4. **Refused with secrets.** A flow with a `{ env }` input ends `error: flow_invalid` when a video is asked for,
   because what is typed would be on the video. Production is already out of reach of every run (ADR 0024).

## Options considered

- **Drive a browser from the agent and screencast it** (the approach of an internal skill that inspired this): works
  on any page without a saved flow, but needs a separate browser tool, records the agent's retries, and puts the
  overlay in the page's light DOM where the app and any check can see it.
- **Playwright trace as the demo**: already recorded, but needs the trace viewer, shows no step captions, and the
  default trace has no screenshots (ADR 0030).
- **Replay video with a shadow-DOM overlay** (chosen): deterministic, model-free, captions from the flow, no new
  dependency.

## Consequences

- **Easier:** "make a demo video" becomes one replay of a saved flow; the clip has no fumbling, and its result line is
  the run's real verdict.
- **Harder:** a recorded replay is slower (about 1 s per step plus 2.5 s); each profile's video also records while
  another profile acts, so a two-role flow gives two clips with idle stretches. There is no conversion to MP4 or GIF
  (no ffmpeg dependency): browsers and GitHub play WebM.
- **Revisit when:** users need one combined clip across profiles, or videos of explorations.
