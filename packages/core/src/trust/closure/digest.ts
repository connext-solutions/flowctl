import { createHash } from 'node:crypto';
import { canonicalJson } from '../canonical.js';
import { TrustError } from '../errors.js';
import type { ClosureFile } from './types.js';

/** What a hook consent binds (ADR 0021 Amendment 2026-11-01 section 2.8, Amendment 2026-11-02 sections 9-10). */
export interface HookDigestInput {
  /** The flows root's project-relative path, or its registered name when outside the project. */
  flowsRoot: string;
  setup: string | undefined;
  teardown: string | undefined;
  /** The env names the owner allowed (validated against the allowlist at consent, not here). */
  env: readonly string[];
  /** Pinned values; every key must be in `env`. */
  pins: Readonly<Record<string, string>>;
  /** The normalised path of the `.pgpass` file, or `null`. */
  pgpass: string | null;
  files: readonly ClosureFile[];
}

const bytewise = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a), Buffer.from(b));

/**
 * The hook consent digest: sha256 (lowercase hex) of the canonical JSON
 * `{v, purpose:"hook", interpreter:"/bin/sh -c", flowsRoot, cwd:".", setup, teardown, env, pins, pgpass,
 * files}`, with `env` and `files` sorted bytewise. A change to any field is `digest_mismatch`.
 *
 * @remarks Its `purpose` keeps it from standing in for the confirm or classify digests, which share only
 *   the closure and file-hashing functions.
 * @throws {TrustError} `trust_entry_invalid` for a duplicate env name or a pin whose name is not in `env`.
 */
export function hookConsentDigest(i: HookDigestInput): string {
  const env = [...i.env].sort(bytewise);
  if (new Set(env).size !== env.length)
    throw new TrustError(
      'trust_entry_invalid',
      'A hook consent lists an env name twice.',
    );
  const stray = Object.keys(i.pins).find((k) => !env.includes(k));
  if (stray !== undefined)
    throw new TrustError(
      'trust_entry_invalid',
      `The pinned name ${stray} is not in the hook's env list.`,
    );
  const doc = {
    v: 1,
    purpose: 'hook',
    interpreter: '/bin/sh -c',
    flowsRoot: i.flowsRoot,
    cwd: '.',
    setup: i.setup ?? null,
    teardown: i.teardown ?? null,
    env,
    pins: { ...i.pins },
    pgpass: i.pgpass,
    files: [...i.files]
      .sort((a, b) => bytewise(a.path, b.path))
      .map((f) => ({ path: f.path, sha256: f.sha256, kind: f.kind })),
  };
  return createHash('sha256').update(canonicalJson(doc)).digest('hex');
}
