import type { McpCommand } from '@flowctl/core';

const ASSERTIONS = `Assertions decide the verdict; write them from the intended behaviour (spec, ticket), never from what the run shows. Each is one of:
{"network":{"method":"POST","url":"/api/leave-requests","status":201,"requestBody":{"type":"LEAVE"}}}  (fetch/xhr only, on the run's own origins; url glob, * matches anything, a leading / matches as a suffix; requestBody is a subset match; add "absent":true to require that no such request happens)
{"text":"Đã lưu"}  (visible page text, case-sensitive; add "within":{"role":"status"} (a locator matching exactly one element) when a list row or comment could already contain the text)
{"url":"/o/*/hrm/leave*"}
{"value":{"locator":{"role":"textbox","name":"Lý do"},"equals":""}}
{"noConsoleErrors":true}`;

/** An MCP tool of the core command registry, without its `mcp ` prefix. */
export type McpTool = McpCommand extends `mcp ${infer T}` ? T : never;

/**
 * The description of each MCP tool: what it does, its inputs, and what to do with the answer. Tool results are
 * compact JSON with a `next` field saying which call comes next.
 */
export const DOCS: Record<McpTool, string> = {
  flow_run: `Start an exploration: the fast System 1 model (TypeSafe Jev) drives a browser toward "goal" on one env, then the run is judged only by "assertions". Waits up to about 55 s, then answers "running" (call flow_wait).
- start: a path on the env starting with / (templates like {{env.org}} allowed); flowctl never leaves the env origin.
- profile: a profile from flowctl.config.yaml with a saved session (flowctl login <profile>).
- inputs: values System 1 may type, e.g. {"reason":{"value":"QA {{uid}}"}}; secrets are not accepted here.
- maxSteps: at most 100; envName: an env from the config (default: defaultEnv).
- allowDestructive: true lets YOU (never System 1) click a control that looks destructive (delete, approve, reject, Xoá, Duyệt...) on a shared env such as stg; never on production or an env the trust store does not list. Without it such a click escalates "destructive_action". A request that looks destructive (any DELETE, a path with delete/approve/purge..., also from an icon-only button or a script) is stopped and the run ends error destructive_blocked, unless it came from your own step with allowDestructive. Set it only when the user asked for that action, on data the run created.
${ASSERTIONS}
Answers: passed (call flow_save), failed (the verdict: report it), escalated (System 1 needs you: answer with flow_step; reason destructive_action means a delete- or approve-like control was not clicked), error (not a product bug: infrastructure, or a guard that stopped the run, e.g. destructive_blocked when a request looked destructive, budget_exceeded when the run passed its wall-clock budget of target.budgets.wallClockMs, 10 minutes by default, escalation waits included).`,
  flow_step: `Continue an exploration. Give steps, a hint, both, or neither (System 1 just continues); or finish: true alone.
- steps: actions you take, run in order before System 1 continues: {"kind":"click","control":3}, {"kind":"fill","control":4,"input":"reason"}, {"kind":"select","control":5,"input":"type"}, {"kind":"goto","url":"/path"}, {"kind":"press","key":"Enter"}, {"kind":"as","profile":"manager","goto":"/approvals"}, {"kind":"wait","ms":500}; control ids come from the last escalation.controls; "input" is an input key from flow_run.
- hint: a sentence added to the goal System 1 works toward.
- finish: true to end now and get the verdict (a run that has not acted yet, other than waiting or scrolling, ends error flow_invalid: assertions that held on arrival verify nothing).
If the answer is "running", call flow_wait; do not send the same flow_step again.`,
  flow_wait: `Wait up to about 55 s more for an exploration that answered "running"; returns where it stopped.`,
  flow_save: `Save a passed exploration as <flowsDir>/<name>.yaml (lowercase letters, digits, dashes). flowctl first replays it once without any model; it is written only if that replay passes, and it replaces an existing flow of that name. Saved flows replay with flow_replay or "flowctl replay".`,
  flow_replay: `Replay saved flows without any model (deterministic) and report the verdicts. names: flow names (default: all); tag: only flows with this tag; envName: an env from the config; repeat: 1-5 to detect flakiness; video: true records a demo video per profile (evidence.videos, video-<profile>.webm) with each step shown on screen, slowed down to be watched, refused for flows with secret inputs; use it when the user asks for a video, screen recording or demo of a flow. A failure is a verdict; read its failed field and evidence directory.`,
};
