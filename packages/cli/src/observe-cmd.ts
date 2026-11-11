import {
  appMapPath,
  type CheckFinding,
  type FreeChecks,
  type LoadedConfig,
  observe,
  type Observation,
  observeSummary,
  type TrustStore,
  writeAppMap,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { terminalSafe } from './summary.js';

/** At most this many findings the human summary prints; the rest are in `checks.json`. */
const MAX_PRINTED = 20;

/** One finding as a line: the check, the page and what was seen there. Page text is escaped. */
function findingLine(f: CheckFinding): string {
  const seen =
    f.message !== undefined
      ? `console error ${JSON.stringify(f.message)}`
      : f.target !== undefined
        ? `link to ${f.target} (${String(f.status ?? 0)})`
        : f.call !== undefined
          ? `call ${f.call.method} ${f.call.origin ?? ''}${f.call.path} ${String(f.status ?? 0)}`
          : f.status === 0
            ? 'no answer'
            : `document ${String(f.status ?? 0)}`;
  return `  ${f.check} ${terminalSafe(f.page)}: ${terminalSafe(seen)}`;
}

/** The free-check lines: the verdict with the failed checks and their finding counts, then at most 20 findings. */
function formatChecks(c: FreeChecks, file: string): string[] {
  const failed = c.checks.filter((r) => r.status === 'failed');
  const findings = failed.flatMap((r) => r.findings);
  const total = failed.reduce((n, r) => n + r.findings.length + r.omitted, 0);
  return [
    failed.length === 0
      ? `Checks: passed (${c.checks.length} checks${c.truncated ? ', on a truncated map' : ''})`
      : `Checks: failed (${failed.map((r) => `${r.id}: ${String(r.findings.length + r.omitted)}`).join(', ')})`,
    ...findings.slice(0, MAX_PRINTED).map(findingLine),
    ...(total > MAX_PRINTED
      ? [`  … ${String(total - MAX_PRINTED)} more in checks.json`]
      : []),
    `Checks file: ${file}`,
  ];
}

/** The human summary: one header line, one line per page, the free checks, then where the map is. Page text is escaped. */
function formatObservation(o: Observation, out: string | undefined): string {
  const { map, run, budget } = o;
  const lines = [
    `Observed ${map.pages.length} page(s) on ${map.origin} (env ${run.env}), run ${run.runId}${map.truncated ? ', truncated' : ''}`,
    ...map.pages.map((p) => {
      const extra = [
        `${p.controls.length} controls`,
        `${p.forms.length} forms`,
        `${p.calls.length} calls`,
        ...(p.consoleErrors.length > 0
          ? [`${p.consoleErrors.length} console errors`]
          : []),
        ...(p.refused.length > 0 ? [`refused: ${p.refused.join(', ')}`] : []),
      ].join(', ');
      return `  ${String(p.status).padStart(3)} ${terminalSafe(p.path)}  ${extra}`;
    }),
    `Budget: ${budget.pages.used}/${budget.pages.max} pages, ${budget.wallClockMs} ms, cost ${budget.costUsd}${budget.stoppedBy === undefined ? '' : `; stopped by the ${budget.stoppedBy} budget`}`,
    ...(run.error === undefined
      ? []
      : [`error: ${run.error.kind}: ${terminalSafe(run.error.hint)}`]),
    ...(o.checks === undefined
      ? []
      : formatChecks(o.checks.result, o.checks.file)),
    `Map: ${o.file}`,
    ...(out === undefined ? [] : [`Copy: ${out}`]),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * `flowctl observe`: crawls the env read-only (core `observe`), prints a short summary with the free checks (or
 * `--json`, core `observeSummary`), and copies the map to `--out` when given (core `writeAppMap`, contained in the
 * flows root, checked before the crawl).
 *
 * @returns the exit code: `2` when the run ended in an error (no checks then), `1` when a free check failed (a
 *   verdict, ADR 0004), else `0`.
 * @throws {ConfigError} for an unknown env or an `--out` path outside the flows root.
 * @throws {FlowError} for an unknown profile or a start that is not a path.
 * @see docs/adr/0033-read-only-crawl.md (amendment: free checks)
 */
export async function observeCmd(
  cfg: LoadedConfig,
  values: Values,
  store: TrustStore | undefined,
  write: (text: string) => void,
): Promise<number> {
  if (values.out !== undefined) appMapPath(cfg, values.out);
  const o = await observe(cfg, {
    env: values.env,
    profile: values.profile,
    start: values.start,
    store,
  });
  const out =
    values.out === undefined ? undefined : writeAppMap(cfg, o.map, values.out);
  write(
    values.json
      ? `${JSON.stringify(observeSummary(o, out), null, 2)}\n`
      : formatObservation(o, out),
  );
  if (o.run.status === 'error') return 2;
  return o.checks?.result.status === 'failed' ? 1 : 0;
}
