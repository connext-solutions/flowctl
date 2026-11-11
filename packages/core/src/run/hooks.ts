import type { LoadedConfig } from '../config.js';
import type { Flow } from '../flow/index.js';
import { RunError } from '../foundation/index.js';
import {
  type HookOutput,
  HookSession,
  TrustError,
  openTrustStore,
  type TrustStore,
} from '../trust/index.js';

/** What a hook run reports: whether it exited 0, and the last 2000 characters of its output. */
export type HookResult = HookOutput;

/**
 * Which trust store a run reads hook consent from: the owner's default store, or one injected by a test
 * through the internal `TrustStore.open(dir)` seam (ADR 0025 section 1).
 */
export type StoreChoice = TrustStore | 'default';

/**
 * Checks hook consent for a flow and makes its snapshot, before anything runs (ADR 0021 Amendment
 * 2026-11-01 sections 1 and 2.7, ADR 0025 section 5). A flow with no hooks returns `undefined`.
 *
 * @remarks An exploration draft has no file (`flow.file === ''`), so it can never hold consent; its hooks are
 *   refused until the flow is saved and `flowctl trust hook <name>` was run. There is no blanket consent:
 *   no flag, variable or option skips this check.
 * @throws {RunError} `hooks_untrusted` with one reason; a missing store is `no_entry`, a store that fails its
 *   own checks names the trust error.
 */
export function prepareHooks(
  cfg: LoadedConfig,
  flow: Pick<Flow, 'name' | 'file' | 'setup' | 'teardown'>,
  store: StoreChoice,
): HookSession | undefined {
  if (flow.setup === undefined && flow.teardown === undefined) return undefined;
  try {
    return HookSession.prepare(openStore(store), {
      flow: flow.file === '' ? undefined : flow.name,
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      setup: flow.setup,
      teardown: flow.teardown,
    });
  } catch (e) {
    if (!(e instanceof TrustError)) throw e;
    throw new RunError(
      'hooks_untrusted',
      `The trust store refused the hooks of flow "${flow.name}" (${e.kind}${e.detail === undefined ? '' : `: ${e.detail}`}): ${e.message}`,
    );
  }
}

/**
 * Runs `setup` or `teardown` from the run's snapshot, with the environment built from the parent's.
 *
 * @param onStart called once the checks passed and the shell is about to start, so a refused hook never
 *   counts as started (and its teardown is not attempted).
 * @throws {RunError} `hooks_untrusted` (`hook_env_unsafe`) when the snapshot changed or the environment
 *   cannot be built.
 */
export function runHookKind(
  hooks: HookSession,
  kind: 'setup' | 'teardown',
  cfg: LoadedConfig,
  onStart?: () => void,
): Promise<HookResult> {
  return hooks.run(kind, process.env, cfg.hookTimeout, onStart);
}

const openStore = (store: StoreChoice): TrustStore | undefined =>
  store === 'default' ? openTrustStore() : store;
