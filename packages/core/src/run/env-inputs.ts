import type { Flow } from '../flow/index.js';
import { RunError } from '../foundation/index.js';
import {
  TrustError,
  allowedEnvVar,
  openTrustStore,
  type TrustStore,
} from '../trust/index.js';
import type { StoreChoice } from './hooks.js';

/**
 * Refuses a flow whose `{ env: NAME }` inputs are not all in the trust store's allowlist for the flow's
 * profile (`profiles.<profile>.envVars`, ADR 0024 section 7, ADR 0025 section 4, issue #41). Runs before any
 * variable is read, so a refused name never leaves `process.env`.
 *
 * @remarks A flow without `{ env }` inputs never opens the store. The store is the only source: no config key,
 *   flag or flow field can add a name. The match is case-insensitive (ADR 0025 section 4), so the returned
 *   inputs read the name as the owner stored it, never the flow's spelling: a flow asking for `qa_password` when
 *   `QA_PASSWORD` is allowed reads `QA_PASSWORD`. Only the flow's own `profile` is checked; values typed after an
 *   `as:` switch are bound to their field and origin by T1.4.
 * @returns the flow's inputs with every `{ env }` name replaced by the stored name.
 * @throws {RunError} `env_not_allowed` naming the input, the variable and the command that allows it; also for a
 *   missing store, or a store that fails its own checks (the trust error is named).
 */
export function checkEnvInputs(
  flow: Pick<Flow, 'name' | 'profile' | 'inputs'>,
  store: StoreChoice,
): Flow['inputs'] {
  const wanted = Object.entries(flow.inputs).flatMap(([key, src]) =>
    'value' in src ? [] : [{ key, name: src.env }],
  );
  if (wanted.length === 0) return flow.inputs;
  const inputs = { ...flow.inputs };
  let opened: TrustStore | undefined;
  try {
    opened = store === 'default' ? openTrustStore() : store;
    for (const w of wanted) {
      if (opened === undefined) break;
      const entry = allowedEnvVar(opened, flow.profile, w.name);
      if (entry === undefined)
        throw new RunError(
          'env_not_allowed',
          `input "${w.key}" of flow "${flow.name}": environment variable ${w.name} is not allowed for profile "${flow.profile}". To allow it on this machine, run: flowctl trust add profile ${flow.profile} ${w.name} secret (or username)`,
        );
      inputs[w.key] = { env: entry.name };
    }
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    throw new RunError(
      'env_not_allowed',
      `The trust store refused the env inputs of flow "${flow.name}" (${e.kind}${e.detail === undefined ? '' : `: ${e.detail}`}): ${e.message}`,
    );
  }
  if (opened === undefined)
    throw new RunError(
      'env_not_allowed',
      `Flow "${flow.name}" reads environment variables, and there is no trust store to allow them. Run: flowctl trust init, then flowctl trust add profile ${flow.profile} <NAME> secret`,
    );
  return inputs;
}
