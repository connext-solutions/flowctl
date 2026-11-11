import { RunError } from '../../foundation/index.js';
import {
  checkHookConsent,
  type HookConsent,
  type HookRefusal,
} from '../consent/index.js';
import type { TrustStore } from '../store.js';
import { flowsRootFor, projectFor } from '../registry.js';
import { buildHookEnv } from './env.js';
import {
  createHookSnapshot,
  type HookSnapshot,
  removeHookSnapshot,
  verifyHookSnapshot,
} from './snapshot.js';
import { type HookOutput, spawnHook } from './spawn.js';

/** The flow whose hooks are about to run, as the store and the run know it. */
export interface HookTarget {
  /** The flow name; for an exploration draft, `undefined` (it has no file to consent). */
  flow: string | undefined;
  /** The project root and the flows directory, as the config resolves them. */
  projectDir: string;
  flowsDir: string;
  setup: string | undefined;
  teardown: string | undefined;
}

/**
 * The hooks of one run, consented and snapshotted (ADR 0021 Amendment 2026-11-01 sections 1 and 2.7, ADR
 * 0025 section 5): `setup` and `teardown` share one snapshot, each runs only after the snapshot is re-hashed
 * and the environment is built, and the snapshot is removed by {@link close}.
 *
 * @example
 * const hooks = HookSession.prepare(store, target); // throws RunError hooks_untrusted or a TrustError
 * await hooks.run('setup', process.env, timeout);
 * await hooks.run('teardown', process.env, timeout);
 * hooks.close();
 */
export class HookSession {
  private constructor(
    private readonly flow: string,
    private readonly snap: HookSnapshot,
    private readonly entry: HookConsent,
    private readonly text: { setup?: string; teardown?: string },
  ) {}

  /**
   * Checks consent and makes the snapshot. A flow with no hooks needs neither and returns `undefined`.
   *
   * @throws {RunError} `hooks_untrusted` naming one reason (`no_entry`, `digest_mismatch`,
   *   `hook_uncovered`, `hook_env_unsafe` with its detail), before any hook runs. The hint never suggests a
   *   flag.
   * @throws {TrustError} `project_not_trusted` or `identity_unverifiable` from the project identity check, and
   *   `trust_tampered` for an entry that is not owner-signed; `prepareHooks` turns them into `hooks_untrusted`.
   */
  static prepare(
    store: TrustStore | undefined,
    t: HookTarget,
  ): HookSession | undefined {
    if (t.setup === undefined && t.teardown === undefined) return undefined;
    const name = t.flow ?? 'exploration';
    if (t.flow === undefined)
      throw untrusted(
        name,
        { reason: 'no_entry' },
        'The exploration request carries setup/teardown shell hooks. Save the flow first, then run: flowctl trust hook <name>',
      );
    if (store === undefined)
      throw untrusted(
        name,
        { reason: 'no_entry' },
        `No trust store on this machine. Run: flowctl trust init, then flowctl trust hook ${name}`,
      );
    const project = projectFor(store, t.projectDir);
    const root = flowsRootFor(store, t.flowsDir, t.projectDir);
    if (project === undefined || root === undefined)
      throw untrusted(
        name,
        { reason: 'no_entry' },
        `This project or its flows directory is not registered in the trust store. Run: flowctl trust init in this project, then flowctl trust hook ${name}`,
      );
    const checked = checkHookConsent(store, {
      project,
      flow: t.flow,
      root: root.path,
      flowsRoot: root.name,
      setup: t.setup,
      teardown: t.teardown,
    });
    if (!checked.ok) throw untrusted(name, checked);
    if (checked.entry === undefined || checked.closure === undefined)
      throw new RunError('internal', `consent for "${name}" returned no entry`);
    const snap = createHookSnapshot(root.path, checked.closure);
    if (typeof snap === 'string')
      throw untrusted(name, {
        reason: 'hook_env_unsafe',
        detail: snap,
        name: '',
      });
    return new HookSession(t.flow, snap, checked.entry, {
      setup: t.setup,
      teardown: t.teardown,
    });
  }

  /**
   * Runs `setup` or `teardown` from the snapshot. A kind the flow does not have succeeds at once.
   *
   * @param parent the caller's environment; only the names ADR 0021 allows are read.
   * @throws {RunError} `hooks_untrusted` (`hook_env_unsafe`) when a closure file changed since the snapshot
   *   (`snapshot_modified`), a `PATH` entry is unsafe or a pinned value does not match.
   */
  async run(
    kind: 'setup' | 'teardown',
    parent: Readonly<Record<string, string | undefined>>,
    timeoutMs: number,
    onStart?: () => void,
  ): Promise<HookOutput> {
    const command = this.text[kind];
    if (command === undefined) return { ok: true, output: '' };
    const modified = verifyHookSnapshot(this.snap);
    if (modified !== undefined)
      throw untrusted(this.flow, {
        reason: 'hook_env_unsafe',
        detail: modified,
        name: '',
      });
    const built = buildHookEnv(this.snap, this.entry, parent);
    if (!built.ok)
      throw untrusted(this.flow, {
        reason: 'hook_env_unsafe',
        detail: built.detail,
        name: built.name,
      });
    onStart?.();
    return spawnHook(command, this.snap.cwd, built.env, timeoutMs);
  }

  /** Removes the snapshot; safe to call more than once. */
  close(): void {
    removeHookSnapshot(this.snap.dir);
  }
}

type Refusal =
  | HookRefusal
  | { reason: 'hook_env_unsafe'; detail: string; name: string };

function untrusted(flow: string, r: Refusal, hint?: string): RunError {
  const why =
    r.reason === 'hook_env_unsafe'
      ? `hook_env_unsafe: ${r.detail}${r.name === '' ? '' : ` (${r.name})`}`
      : r.reason;
  const next =
    r.reason === 'hook_env_unsafe'
      ? 'Fix the environment named above and run again.'
      : `Review the hooks, then run: flowctl trust hook ${flow}`;
  return new RunError(
    'hooks_untrusted',
    `Flow "${flow}" runs shell hooks that cannot run (${why}). ${hint ?? next}`,
  );
}
