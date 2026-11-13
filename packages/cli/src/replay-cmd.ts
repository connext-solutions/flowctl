import {
  ConfigError,
  exitCodeFor,
  FlowError,
  findFlowsWithErrors,
  type LoadedConfig,
  replayMany,
  resolveEnv,
  summarize,
  type TrustStore,
} from '@flowctl/core';
import { traceMode, videoMode, type Values } from './argv.js';
import { formatSummary, invalidFlowResult } from './summary.js';

/**
 * `flowctl replay [name...]`: finds the flows, replays them (`--repeat` times) and prints the summary, as text or
 * as `--json`. Invalid flow files are reported as failed results beside the runs.
 *
 * @returns the exit code of the summary.
 * @throws {ConfigError} when `--repeat` is not a positive integer; {@link FlowError} when no flow matched.
 */
export async function replayCmd(
  cfg: LoadedConfig,
  args: string[],
  values: Values,
  store: TrustStore | undefined,
  write: (text: string) => void,
): Promise<number> {
  if (values['trust-hooks'])
    process.stderr.write(
      'flowctl: --trust-hooks is ignored: hooks run only with consent in the trust store (flowctl trust hook <name>; ADR 0025 section 5)\n',
    );
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1)
    throw new ConfigError('--repeat must be a positive integer');
  const { flows, errors } = findFlowsWithErrors(
    cfg.flowsPath,
    Object.keys(cfg.profiles),
    { names: args, tag: values.tag },
  );
  if (flows.length === 0 && errors.length === 0)
    throw new FlowError(`No flows matched in ${cfg.flowsPath}`);
  const env = resolveEnv(cfg, values.env).name;
  const ran =
    flows.length === 0
      ? summarize([])
      : await replayMany(cfg, flows, {
          env: values.env,
          repeat,
          headed: values.headed,
          heal: values.heal,
          store,
          trace: traceMode(values.trace),
          video: videoMode(values.video),
          acceptHeals: values['accept-heals'],
        });
  const summary = summarize([
    ...ran.results,
    ...errors.map((e) => invalidFlowResult(e, env)),
  ]);
  write(
    values.json
      ? `${JSON.stringify(summary, null, 2)}\n`
      : formatSummary(summary),
  );
  return exitCodeFor(summary);
}
