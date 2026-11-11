import {
  appMapPath,
  type LoadedConfig,
  observe,
  type Observation,
  observeSummary,
  type TrustStore,
  writeAppMap,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { terminalSafe } from './summary.js';

/** The human summary: one header line, one line per page, then where the map is. Page text is escaped. */
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
    `Map: ${o.file}`,
    ...(out === undefined ? [] : [`Copy: ${out}`]),
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * `flowctl observe`: crawls the env read-only (core `observe`), prints a short summary (or `--json`, core
 * `observeSummary`), and copies the map to `--out` when given (core `writeAppMap`, contained in the flows root, checked
 * before the crawl).
 *
 * @returns the exit code: `0` when the crawl finished (a map is not a verdict), `2` when the run ended in an error.
 * @throws {ConfigError} for an unknown env or an `--out` path outside the flows root.
 * @throws {FlowError} for an unknown profile or a start that is not a path.
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
  return o.run.status === 'error' ? 2 : 0;
}
