import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type Closure,
  computeClosure,
  readVerifiedFile,
} from './closure/index.js';
import { createHookConsent, type HookRequest } from './consent/index.js';
import { TrustError } from './errors.js';
import type { OwnerKey } from './owner-key.js';
import { flowsRootFor, projectFor } from './registry.js';
import { TrustStore } from './store.js';
import { defaultStoreDir } from './location.js';
import { replaceStoreDoc } from './write.js';

/**
 * Refuses a change to `store` that `key` may not sign: a store marked `ci` is provisioned on another machine
 * and never changed in place, and only the pinned owner key signs entries (ADR 0025 section 3).
 *
 * @throws {TrustError} `trust_entry_invalid` for a `ci` store; `trust_tampered` (`owner_key_mismatch`) for
 *   another key.
 */
export function assertCanWrite(store: TrustStore, key: OwnerKey): void {
  if (store.isCi)
    throw new TrustError(
      'trust_entry_invalid',
      'This trust store is marked ci and is read-only; change it on the owner machine and re-provision it.',
    );
  if (store.data.ownerFingerprint !== key.fingerprint)
    throw new TrustError(
      'trust_tampered',
      'The unlocked owner key is not the key this store pins.',
      'owner_key_mismatch',
    );
}

/**
 * Refuses when a store already exists in `storeDir`, so `trust init` can stop before it creates a key.
 *
 * @remarks A second project on this machine is registered with `flowctl trust add project`, not a second `init`.
 * @throws {TrustError} `store_exists`.
 */
export function assertNoStore(storeDir: string): void {
  if (existsSync(join(storeDir, 'trust.json')))
    throw new TrustError(
      'store_exists',
      `A trust store already exists in ${storeDir}. To register another project, run in that project: flowctl trust add project`,
    );
}

/** What the owner is shown before consenting to one flow's hooks: the request, its closure, and every file in full. */
export interface HookPlan {
  request: HookRequest;
  closure: Closure;
  /** Each closure file's text, read from the bytes the closure hashed. */
  files: { path: string; kind: 'script' | 'data'; text: string }[];
}

/**
 * Resolves a flow's project and flows root in the store and computes its closure, for the consent screen.
 *
 * @throws {TrustError} `project_not_trusted` when the project or its flows directory is not registered;
 *   `trust_tampered` for an entry that is not owner-signed; `identity_unverifiable` when the checkout has no usable
 *   history (ADR 0025 section 1).
 */
export function planHookConsent(
  store: TrustStore,
  t: {
    projectDir: string;
    flowsDir: string;
    flow: string;
    setup: string | undefined;
    teardown: string | undefined;
  },
): HookPlan {
  const project = projectFor(store, t.projectDir);
  const root = flowsRootFor(store, t.flowsDir, t.projectDir);
  if (project === undefined || root === undefined)
    throw new TrustError(
      'project_not_trusted',
      'This project or its flows directory is not registered in the trust store. Run: flowctl trust init',
    );
  const request: HookRequest = {
    project,
    flow: t.flow,
    root: root.path,
    flowsRoot: root.name,
    setup: t.setup,
    teardown: t.teardown,
  };
  const closure = computeClosure({
    root: root.path,
    setup: t.setup,
    teardown: t.teardown,
  });
  const files = closure.files.map((f) => {
    const bytes = readVerifiedFile(root.path, f.path, f.sha256);
    if (bytes === undefined)
      throw new TrustError(
        'confirmation_mismatch',
        `${f.path} changed while flowctl read it; run flowctl trust hook again.`,
      );
    return { path: f.path, kind: f.kind, text: bytes.toString('utf8') };
  });
  return { request, closure, files };
}

/**
 * Signs one consent per plan and writes them into the store in one atomic replace.
 *
 * @throws {TrustError} `trust_entry_invalid` for a store marked `ci` (it is provisioned elsewhere), for a
 *   hook that cannot be shown, or for env names and pins the allowlist refuses.
 */
export function saveHookConsents(
  store: TrustStore,
  key: OwnerKey,
  items: { plan: HookPlan; env: string[]; pins: Record<string, string> }[],
): string[] {
  assertCanWrite(store, key);
  const hooks = { ...store.data.hooks };
  const ids: string[] = [];
  for (const item of items) {
    const c = createHookConsent(
      key,
      item.plan.request,
      { env: item.env, pins: item.pins, pgpass: null },
      item.plan.closure,
    );
    hooks[c.id] = { value: c.value, sig: c.sig };
    ids.push(c.id);
  }
  replaceStoreDoc(store.dir, { ...store.data, hooks }, key);
  return ids;
}

/**
 * Opens the owner's trust store at its fixed location (ADR 0025 section 1). There is no way to name another
 * directory here: a test store is opened through the internal `TrustStore.open(dir)` seam only.
 *
 * @returns the store, or `undefined` when there is none yet.
 * @throws {TrustError} every refusal of `TrustStore.open` other than `trust_missing`.
 */
export function openTrustStore(): TrustStore | undefined {
  try {
    return TrustStore.open(defaultStoreDir());
  } catch (e) {
    if (e instanceof TrustError && e.kind === 'trust_missing') return undefined;
    throw e;
  }
}

const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zs}]/gu;

/**
 * Text as a confirmation screen shows it (ADR 0025 section 3, display rules): every control, format,
 * private-use or unassigned code point and every space other than U+0020 is written `\u{XXXX}`, so nothing
 * the owner confirms can hide. Newline and tab are kept as layout.
 */
export function displayText(text: string): string {
  return text.replace(HIDDEN, (c) =>
    c === '\n' || c === '\t' || c === ' '
      ? c
      : `\\u{${(c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}}`,
  );
}
