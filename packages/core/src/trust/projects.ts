import { realpathSync } from 'node:fs';
import { NAME_PATTERN } from '../foundation/index.js';
import { assertCanWrite } from './admin.js';
import { TrustError } from './errors.js';
import { projectIdentity } from './identity.js';
import type { OwnerKey } from './owner-key.js';
import { TrustStore } from './store.js';
import { replaceStoreDoc } from './write.js';

const invalid = (message: string): TrustError =>
  new TrustError('trust_entry_invalid', message);

const realDir = (dir: string): string => {
  try {
    return realpathSync(dir);
  } catch {
    throw invalid(`The directory ${dir} does not exist; create it first.`);
  }
};

/** What `trust add project` would write, for the owner to see before confirming. */
export interface ProjectPlan {
  name: string;
  root: string;
  flows: string;
  identity: string[];
  /** True when an entry of this name and root exists without an identity and is being upgraded. */
  upgrade: boolean;
}

/**
 * Checks a `trust add project` request against the store and computes the checkout's identity, without writing.
 *
 * @throws {TrustError} `trust_entry_invalid` for a bad name, a missing directory, a name or root already
 *   registered with an identity, or a `ci` store; `identity_unverifiable` when the checkout has no usable
 *   history; `trust_tampered` for an existing entry that is not owner-signed.
 */
export function planProject(
  store: TrustStore,
  t: { name: string; projectDir: string; flowsDir: string },
): ProjectPlan {
  if (store.isCi)
    throw invalid(
      'This trust store is marked ci and is read-only; change it on the owner machine and re-provision it.',
    );
  if (!NAME_PATTERN.test(t.name))
    throw invalid(
      `The project name "${t.name}" must use lowercase letters, digits and dashes.`,
    );
  const root = realDir(t.projectDir);
  const flows = realDir(t.flowsDir);
  const identity = projectIdentity(root);
  let upgrade = false;
  for (const [name, p] of Object.entries(store.data.projects)) {
    if (name !== t.name && p.root !== root) continue;
    const { sig, ...value } = p;
    store.assertSigned({ id: name, kind: 'projects', value }, sig ?? '');
    if (name === t.name && p.root === root && p.identity.length === 0) {
      upgrade = true;
      continue;
    }
    throw invalid(
      name === t.name
        ? `The project "${name}" is already registered (root ${p.root}); nothing was changed. Choose another name, or to start over remove ${store.dir} and run: flowctl trust init`
        : `The directory ${root} is already registered as project "${name}"; nothing was changed. If its history changed, remove ${store.dir} and run: flowctl trust init`,
    );
  }
  return { name: t.name, root, flows, identity, upgrade };
}

/**
 * Registers a project in the store (`flowctl trust add project`, ADR 0025 section 3): its root, the identity
 * computed now, and its flows directory as a `flows` root, each signed with the owner key. An entry of the same
 * name and root that has no identity yet is upgraded in place.
 *
 * @remarks The store is read again after the owner answered, and the plan is recomputed against it, so a change
 *   written meanwhile is kept and a checkout whose history changed meanwhile is caught.
 * @throws {TrustError} every refusal of {@link planProject}; `confirmation_mismatch` when the identity changed
 *   after the owner saw it; `trust_tampered` when the key is not the pinned owner key.
 */
export function addProject(
  store: TrustStore,
  key: OwnerKey,
  shown: ProjectPlan,
): void {
  const fresh = TrustStore.open(store.dir);
  assertCanWrite(fresh, key);
  const plan = planProject(fresh, {
    name: shown.name,
    projectDir: shown.root,
    flowsDir: shown.flows,
  });
  if (plan.identity.join() !== shown.identity.join())
    throw new TrustError(
      'confirmation_mismatch',
      `The root commits of ${plan.root} changed after they were shown; nothing was changed. Run the command again.`,
    );
  const old = fresh.data.projects[plan.name];
  const value = {
    root: plan.root,
    identity: plan.identity,
    defaultEnv: old?.defaultEnv,
    language: old?.language,
    locale: old?.locale,
  };
  const flowsRoot = { purpose: 'flows' as const, path: plan.flows };
  const hasRoot = fresh.data.roots.some(
    (r) => r.purpose === 'flows' && r.path === plan.flows,
  );
  replaceStoreDoc(
    fresh.dir,
    {
      ...fresh.data,
      projects: {
        ...fresh.data.projects,
        [plan.name]: {
          ...value,
          sig: key.signEntry({ id: plan.name, kind: 'projects', value }),
        },
      },
      roots: hasRoot
        ? fresh.data.roots
        : [
            ...fresh.data.roots,
            {
              ...flowsRoot,
              sig: key.signEntry({
                id: plan.flows,
                kind: 'roots',
                value: flowsRoot,
              }),
            },
          ],
    },
    key,
  );
}
