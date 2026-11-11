import { realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { TrustError } from './errors.js';
import { identityMatches, projectIdentity } from './identity.js';
import type { TrustStoreDoc } from './schema.js';
import type { TrustStore } from './store.js';

/** A registered flows root: its real path and the name the hook digest records for it. */
export interface FlowsRoot {
  path: string;
  name: string;
}

const real = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

/**
 * The project whose registered root is the real path of `projectDir` and whose recorded identity matches the
 * checkout's root commits, verified against the owner key (`projects` is a signed kind, ADR 0025 sections 1 and
 * 3).
 *
 * @returns the project name, or `undefined` when no entry has this root.
 * @throws {TrustError} `trust_tampered` when the matching entry is not owner-signed; `project_not_trusted` when
 *   the checkout's history does not contain the recorded root commits (a copied directory with another history),
 *   or the entry predates identity; `identity_unverifiable` when the identity cannot be computed.
 */
export function projectFor(
  store: TrustStore,
  projectDir: string,
): string | undefined {
  const want = real(projectDir);
  if (want === undefined) return undefined;
  for (const [name, p] of Object.entries(store.data.projects)) {
    if (p.root !== want) continue;
    const { sig, ...value } = p;
    store.assertSigned({ id: name, kind: 'projects', value }, sig ?? '');
    if (p.identity.length === 0)
      throw new TrustError(
        'project_not_trusted',
        `The project "${name}" in the trust store has no recorded repository identity (it was registered before flowctl checked one). Run: flowctl trust add project`,
        'no_identity',
      );
    if (!identityMatches(p.identity, projectIdentity(want)))
      throw new TrustError(
        'project_not_trusted',
        `The checkout at ${want} does not descend from the repository the owner registered as "${name}" (its root commits differ). If this is a different repository, register it with: flowctl trust add project`,
        'identity_mismatch',
      );
    return name;
  }
  return undefined;
}

/** A project entry as the trust store records it, after its owner signature was verified. */
export type TrustedProject = Omit<TrustStoreDoc['projects'][string], 'sig'>;

/**
 * The project `name` of the store, verified against the owner key on this read.
 *
 * @returns the entry, or `undefined` when the store has no such project.
 * @throws {TrustError} `trust_tampered` when the entry is not owner-signed.
 */
export function trustedProject(
  store: TrustStore,
  name: string,
): TrustedProject | undefined {
  const all = store.data.projects;
  const p = Object.hasOwn(all, name) ? all[name] : undefined;
  if (p === undefined) return undefined;
  const { sig, ...value } = p;
  store.assertSigned({ id: name, kind: 'projects', value }, sig ?? '');
  return value;
}

/**
 * The `flows` root whose path is the real path of `flowsDir`, verified against the owner key (`roots` is a
 * signed kind). Its digest name is the registered `name`, or else its path relative to the project root.
 *
 * @throws {TrustError} `trust_tampered` when the matching entry is not owner-signed.
 */
export function flowsRootFor(
  store: TrustStore,
  flowsDir: string,
  projectDir: string,
): FlowsRoot | undefined {
  const want = real(flowsDir);
  if (want === undefined) return undefined;
  for (const r of store.data.roots) {
    if (r.purpose !== 'flows' || r.path !== want) continue;
    const { sig, ...value } = r;
    store.assertSigned({ id: r.path, kind: 'roots', value }, sig ?? '');
    const base = real(projectDir) ?? projectDir;
    return { path: r.path, name: r.name ?? relative(base, r.path) };
  }
  return undefined;
}
