import { basename } from 'node:path';
import type {
  CleanupResult,
  FlowFileError,
  ReplaySummary,
  RunResult,
} from '@flowctl/core';

/**
 * Turns an unloadable flow file into an `error` result so it shows in the summary and the JSON.
 *
 * @remarks No run happened, so there is no evidence: `evidence.dir` is empty. The hint is the
 *   loader's message, which always names the file. `--repeat` does not multiply these results.
 *   With only invalid files, `replay --heal` reports them (exit 2) and never reaches the heal
 *   configuration check, because no flow is replayed.
 */
export function invalidFlowResult(e: FlowFileError, env: string): RunResult {
  return {
    runId: '',
    flow: basename(e.file, '.yaml'),
    env,
    status: 'error',
    error: { kind: 'flow_invalid', hint: e.message },
    steps: 0,
    healed: [],
    teardownFailed: false,
    weakLocators: [],
    evidence: { dir: '', traces: [], network: [], console: [] },
    ms: 0,
  };
}

/** The longest page-derived text one summary line shows; the full value is in `--json` and the evidence. */
export const MAX_SHOWN = 300;

/**
 * Control characters (C0, DEL, C1), line and paragraph separators, and the bidirectional and zero-width format
 * characters: anything that can move the cursor, hide text or reorder it on a terminal.
 */
const UNSAFE_CLASS =
  '[\\u0000-\\u001f\\u007f-\\u009f\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u2028-\\u202e\\u2060-\\u206f\\ufeff]';
const UNSAFE = new RegExp(UNSAFE_CLASS, 'gu');

/**
 * `text` made safe to print on a terminal (issue #54): every unsafe character is written `\u{XXXX}` (`\n`, `\r`
 * and `\t` keep their short form), and the result is cut to `max` characters with `…`. A page that puts escape
 * sequences into an input value, a console message or a response body can then neither forge a pass line nor hide
 * the failure.
 *
 * @example terminalSafe('\u001b[8m✔ ok') // '\\u{001B}[8m✔ ok'
 */
export function terminalSafe(text: string, max: number = MAX_SHOWN): string {
  const escaped = text.replace(UNSAFE, (c) =>
    c === '\n'
      ? '\\n'
      : c === '\r'
        ? '\\r'
        : c === '\t'
          ? '\\t'
          : `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`,
  );
  const chars = [...escaped];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : escaped;
}

function describeResult(r: RunResult): string {
  const t = terminalSafe;
  const head = `${t(r.flow)} [${t(r.env)}]`;
  if (r.status === 'passed') return `✔ ${head} ${r.ms}ms`;
  if (r.status === 'error')
    return `! ${head} error ${r.error?.kind ?? 'internal'}: ${t(r.error?.hint ?? '')}`;
  const f = r.failed;
  const why =
    f === undefined
      ? 'failed'
      : 'step' in f
        ? `step ${f.step} ${f.kind}: ${t(f.message)}`
        : `assertion ${t(JSON.stringify(f.assertion))} got: ${t(f.got)}`;
  return `✘ ${head} ${why}\n  evidence: ${t(r.evidence.dir, Infinity)}`;
}

export function formatSummary(s: ReplaySummary): string {
  const lines = s.results.flatMap((r) => [
    describeResult(r),
    ...(r.teardownFailed
      ? [`  ⚠ teardown failed (see ${terminalSafe(r.evidence.dir, Infinity)})`]
      : []),
    ...(r.cleanup === undefined || r.cleanup.leftover.length === 0
      ? []
      : [
          `  ⚠ cleanup_incomplete: ${r.cleanup.leftover.length} record(s) left: ${terminalSafe(r.cleanup.leftover.map((l) => `${l.entry} ${l.id ?? `name ${l.name ?? '?'}`} (${l.detail})`).join(', '))}; run flowctl cleanup ${terminalSafe(r.runId)}`,
        ]),
    ...(r.weakLocators.length > 0
      ? [`  ⚠ weak locators: ${terminalSafe(r.weakLocators.join(', '))}`]
      : []),
    ...(r.heals ?? []).map(
      (h) =>
        `  ⚕ healed step ${h.step}: ${terminalSafe(h.from)} → ${terminalSafe(h.to)}${h.written ? ' (written to the flow)' : r.status === 'passed' ? ' (not written: check it, then rerun with --heal --accept-heals)' : ' (not written: the run did not pass)'}`,
    ),
  ]);
  for (const f of s.flows.filter((x) => x.flaky))
    lines.push(`~ ${terminalSafe(f.flow)} flaky: ${f.statuses.join(', ')}`);
  lines.push(
    `${s.passed} passed, ${s.failed} failed, ${s.flaky} flaky, ${s.errors} errors`,
  );
  return `${lines.join('\n')}\n`;
}

/**
 * What `flowctl cleanup <run id>` prints: the count confirmed deleted, a warning when the ledger's last line was torn,
 * then one line per record left.
 */
export function formatCleanup(runId: string, r: CleanupResult): string {
  const lines = [
    `${terminalSafe(runId)}: ${r.confirmed} record(s) confirmed deleted, ${r.leftover.length} left`,
    ...(r.tornTail === true
      ? [
          '  ⚠ the last line of the ledger was torn (a crash cut it short) and was dropped; a create it recorded shows as create_unconfirmed',
        ]
      : []),
    ...(r.staleLock === true
      ? [
          '  ⚠ a lock left by a flowctl process that is gone was removed; check that no run of this id is still going',
        ]
      : []),
    ...r.leftover.map(
      (l) =>
        `  ⚠ ${terminalSafe(l.entry)} ${l.id === null ? `name ${terminalSafe(l.name ?? '?')}` : `id ${terminalSafe(l.id)}`}: ${l.detail}`,
    ),
  ];
  return `${lines.join('\n')}\n`;
}
