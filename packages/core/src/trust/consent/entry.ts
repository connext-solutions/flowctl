import { z } from 'zod';
import { NAME_PATTERN } from '../../foundation/index.js';
import { canonicalJson } from '../canonical.js';
import {
  type Closure,
  computeClosure,
  hookConsentDigest,
} from '../closure/index.js';
import { TrustError } from '../errors.js';
import type { OwnerKey } from '../owner-key.js';
import type { TrustStore } from '../store.js';
import { checkHookEnv, type HookEnvProblem } from './env.js';

const Reason = z.string();

/** The value of one `hooks` entry (ADR 0025 section 5, ADR 0021 Amendment 2026-11-01 section 2.8). */
const HookConsentSchema = z
  .object({
    project: z.string(),
    flow: z.string(),
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    env: z.array(z.string()),
    pins: z.record(z.string(), z.string()),
    pgpass: z.string().nullable(),
    uncovered: z.array(
      z
        .object({ reason: Reason, in: z.string(), subject: z.string() })
        .strict(),
    ),
    unbound: z.boolean(),
  })
  .strict();
export type HookConsent = z.infer<typeof HookConsentSchema>;

const StoredSchema = z.object({ value: z.unknown(), sig: z.string() }).strict();

/** What a hook consent is about: the flow, where its files live, and its current hook text. */
export interface HookRequest {
  project: string;
  flow: string;
  /** Absolute path of the flows root (the store's `flows` root). */
  root: string;
  /** The flows root as the digest names it (project-relative path or registered name). */
  flowsRoot: string;
  setup: string | undefined;
  teardown: string | undefined;
  /** Test seam for the `#!/bin/dash` check; passed to the closure. */
  interpreterOk?: (path: string) => boolean;
}

/** Why a hook may not run: the one reason of ADR 0025 section 5, and a detail for `hook_env_unsafe`. */
export type HookRefusal =
  | { reason: 'no_entry' | 'digest_mismatch' | 'hook_uncovered' }
  | { reason: 'hook_env_unsafe'; detail: HookEnvProblem; name: string };

/**
 * The store key of a hook consent: one entry per (project, flow name). Both names must match `NAME_PATTERN`
 * (no `/`), so two different pairs never share a key.
 *
 * @throws {TrustError} `trust_entry_invalid` for a project or flow name outside `NAME_PATTERN`.
 */
export function hookEntryId(project: string, flow: string): string {
  if (!NAME_PATTERN.test(project) || !NAME_PATTERN.test(flow))
    throw new TrustError(
      'trust_entry_invalid',
      'A hook consent needs a project and flow name of lowercase letters, digits and dashes.',
    );
  return `${project}/${flow}`;
}

/**
 * Builds and signs a hook consent from the current hook text, its closure and the owner's env choices. It is
 * what `flowctl trust hook <name>` writes after the owner saw the text and every closure file.
 *
 * @param shown the closure the owner was shown; when given, the closure recomputed here must equal it, so
 *   the signed bytes are exactly the bytes on the screen (ADR 0025 section 3).
 * @remarks `--pgpass` is not supported yet: the file must be bound into `files` and copied by the snapshot
 *   run (C5), so a non-null `pgpass` is refused until then. Refusing an entry with an `uncovered` list for a
 *   `ci` store is the command's job, since this function takes no store.
 * @throws {TrustError} `trust_entry_invalid` for a bad project or flow name; when the hook cannot be shown at
 *   consent (a refused byte or a file over 256 KiB); when `env` or `pins` break the rules of ADR 0021
 *   Amendment 2026-11-02 sections 9 and 10 (the message names the variable, never its value); or for a
 *   non-null `pgpass`; `confirmation_mismatch` when the closure differs from `shown`.
 */
export function createHookConsent(
  key: OwnerKey,
  req: HookRequest,
  choices: {
    env: string[];
    pins: Record<string, string>;
    pgpass: string | null;
  },
  shown?: Closure,
): { id: string; value: HookConsent; sig: string; closure: Closure } {
  const id = hookEntryId(req.project, req.flow);
  if (choices.pgpass !== null)
    throw new TrustError(
      'trust_entry_invalid',
      'A .pgpass file for hooks is not supported yet; consent without --pgpass.',
    );
  const closure = computeClosure({
    root: req.root,
    setup: req.setup,
    teardown: req.teardown,
    interpreterOk: req.interpreterOk,
  });
  if (!closure.consentable)
    throw new TrustError(
      'trust_entry_invalid',
      `The hooks of flow "${req.flow}" cannot be shown in full (a refused byte or a file over 256 KiB), so they cannot be consented.`,
    );
  if (shown !== undefined && !sameClosure(closure, shown))
    throw new TrustError(
      'confirmation_mismatch',
      `The hooks of flow "${req.flow}" or a file they call changed while you reviewed them; nothing was signed. Run flowctl trust hook again.`,
    );
  const env = checkHookEnv(choices.env, choices.pins);
  if (env !== undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `The hook env variable ${env.name} is refused (${env.problem}); see ADR 0021 Amendment 2026-11-02 sections 9 and 10.`,
    );
  const value: HookConsent = {
    project: req.project,
    flow: req.flow,
    digest: digestOf(req, closure, choices),
    env: [...choices.env].sort((a, b) =>
      Buffer.compare(Buffer.from(a), Buffer.from(b)),
    ),
    pins: { ...choices.pins },
    pgpass: choices.pgpass,
    uncovered: closure.uncovered,
    unbound: closure.unbound,
  };
  return {
    id,
    value,
    sig: key.signEntry({ id, kind: 'hooks', value }),
    closure,
  };
}

/**
 * Decides whether a flow's hooks may run now (ADR 0025 section 5, ADR 0021 Amendment 2026-11-01 section 1):
 * the store must hold an owner-signed entry for (project, flow) whose env still passes the allowlist and whose
 * digest equals the digest of the current text and closure. A store marked `ci` ignores an entry with an
 * `uncovered` list; any other store honours it, because the owner saw the list at consent.
 *
 * @remarks The recomputed closure must also give the same `uncovered` list and `unbound` flag as the signed
 *   entry: the list is not in the digest and can change with the files unchanged (`interpreter_missing` on a
 *   runner without `/bin/dash`), so a difference is `digest_mismatch` (ADR 0021 Amendment 2026-11-01 section
 *   2.8). Pinned values are compared with the parent environment when the hook starts (C5); this check reads
 *   no environment. A flow with no hooks needs no entry and passes.
 * @returns the entry and closure to run with, or the one refusal reason.
 * @throws {TrustError} `trust_tampered` when the entry is not signed by the owner key or has a bad shape.
 */
export function checkHookConsent(
  store: TrustStore,
  req: HookRequest,
):
  | { ok: true; entry: HookConsent | undefined; closure: Closure | undefined }
  | ({ ok: false } & HookRefusal) {
  if (req.setup === undefined && req.teardown === undefined)
    return { ok: true, entry: undefined, closure: undefined };
  const id = hookEntryId(req.project, req.flow);
  const raw = Object.hasOwn(store.data.hooks, id)
    ? store.data.hooks[id]
    : undefined;
  if (raw === undefined) return { ok: false, reason: 'no_entry' };
  const stored = StoredSchema.safeParse(raw);
  const value = HookConsentSchema.safeParse(
    stored.success ? stored.data.value : undefined,
  );
  if (!stored.success || !value.success)
    throw new TrustError(
      'trust_tampered',
      `The hook consent "${id}" has a bad shape; the store was changed outside flowctl.`,
      'bad_entry',
    );
  store.assertSigned({ id, kind: 'hooks', value: value.data }, stored.data.sig);
  const entry = value.data;
  if (entry.project !== req.project || entry.flow !== req.flow)
    throw new TrustError(
      'trust_tampered',
      `The hook consent "${id}" names another flow.`,
      'bad_entry',
    );
  const env = checkHookEnv(entry.env, entry.pins);
  if (env !== undefined)
    return {
      ok: false,
      reason: 'hook_env_unsafe',
      detail: env.problem,
      name: env.name,
    };
  if (store.isCi && entry.uncovered.length > 0)
    return { ok: false, reason: 'hook_uncovered' };
  const closure = computeClosure({
    root: req.root,
    setup: req.setup,
    teardown: req.teardown,
    interpreterOk: req.interpreterOk,
  });
  if (
    !closure.consentable ||
    digestOf(req, closure, entry) !== entry.digest ||
    canonicalJson(closure.uncovered) !== canonicalJson(entry.uncovered) ||
    closure.unbound !== entry.unbound
  )
    return { ok: false, reason: 'digest_mismatch' };
  return { ok: true, entry, closure };
}

const digestOf = (
  req: HookRequest,
  closure: Closure,
  c: {
    env: readonly string[];
    pins: Readonly<Record<string, string>>;
    pgpass: string | null;
  },
): string =>
  hookConsentDigest({
    flowsRoot: req.flowsRoot,
    setup: req.setup,
    teardown: req.teardown,
    env: c.env,
    pins: c.pins,
    pgpass: c.pgpass,
    files: closure.files,
  });

/** Whether two closures bind the same files and report the same uncovered list. */
const sameClosure = (a: Closure, b: Closure): boolean =>
  canonicalJson({ f: a.files, u: a.uncovered, b: a.unbound }) ===
  canonicalJson({ f: b.files, u: b.uncovered, b: b.unbound });
