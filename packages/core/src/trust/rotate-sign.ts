import { z } from 'zod';
import { TrustError } from './errors.js';
import type { OwnerKey } from './owner-key.js';
import type { TrustStoreDoc } from './schema.js';
import type { SignedEntry } from './signing.js';
import { TrustStore } from './store.js';

/** How many signed entries of each kind a rotation re-signs; the confirmation screen shows it. */
export type EntryCounts = Record<
  | 'projects'
  | 'roots'
  | 'envs'
  | 'profiles'
  | 'productionOrigins'
  | 'hooks'
  | 'anchor'
  | 'system1',
  number
>;

/** Signed sections whose signing flowctl does not implement yet; a rotation cannot vouch for them. */
const UNSUPPORTED = [
  'reviewerKeys',
  'destructiveConfirm',
  'handWritten',
] as const;

const StoredHook = z.object({ value: z.unknown(), sig: z.string() }).strict();

/** The refusal when a store cannot be verified in full: before a rotation, or before a replacement. */
export type Unverified = 'rotate_unverified' | 'replace_unverified';

const HINT: Record<Unverified, string> = {
  rotate_unverified:
    'Restore the store, or replace it with flowctl trust init --replace.',
  replace_unverified:
    'Remove the store directory (and <store>.new, if present) by hand and run flowctl trust init.',
};

const unverifiedError = (kind: Unverified, what: string): TrustError =>
  new TrustError(
    kind,
    `The trust store cannot be fully verified with the current owner key (${what}); nothing was changed. ${HINT[kind]}`,
  );

/**
 * Opens the store a rotation or a replacement starts from. For a replacement a store that fails its read checks
 * (a corrupted `trust.log`, a bad signature) is `replace_unverified`: the owner removes it by hand (section 6, step 1).
 *
 * @throws {TrustError} `replace_unverified` in place of `trust_tampered` for a replacement; any refusal of
 *   {@link TrustStore.open} otherwise.
 */
export function openToVerify(
  storeDir: string,
  refusal: Unverified,
): TrustStore {
  try {
    return TrustStore.open(storeDir);
  } catch (e) {
    if (
      refusal === 'replace_unverified' &&
      e instanceof TrustError &&
      e.kind === 'trust_tampered'
    )
      throw new TrustError(
        refusal,
        e.detail === 'anchor_unreachable'
          ? `${e.message} If the keychain is locked or the anchor directory is not mounted, fix that and run the command again; nothing was changed.`
          : `The trust store does not verify (${e.message}); nothing was changed. ${HINT[refusal]}`,
        e.detail,
      );
    throw e;
  }
}

/**
 * Verifies every signed entry of `store` with the pinned (old) key and returns the document with each entry signed
 * again by `next`, the new fingerprint and public key pinned (ADR 0025 Amendment 2026-11-02 section 5, step 1 and
 * the `trust.json.new` of step 2).
 *
 * @param next the new key; without it the entries are only verified and the document comes back unchanged.
 * @param refusal the kind to refuse with: `replace_unverified` for `trust init --replace` (section 6, step 1).
 * @remarks Entries keep their values byte for byte; only `sig` changes. `head` is left for the writer to set.
 * @throws {TrustError} `refusal` (default `rotate_unverified`) when an entry has no signature or one that does not verify, or when a
 *   signed section flowctl cannot re-sign yet (`reviewerKeys`, `destructiveConfirm`, `handWritten`) is not empty.
 */
export function resignStore(
  store: TrustStore,
  next?: OwnerKey,
  refusal: Unverified = 'rotate_unverified',
): TrustStoreDoc {
  const unverified = (what: string): TrustError =>
    unverifiedError(refusal, what);
  const d = store.data;
  for (const section of UNSUPPORTED)
    if (d[section].length > 0)
      throw unverified(`the ${section} section cannot be verified yet`);
  const check = (entry: SignedEntry, sig: string | undefined): string => {
    try {
      store.assertSigned(entry, sig ?? '');
    } catch (e) {
      if (e instanceof TrustError && e.kind === 'trust_tampered')
        throw unverified(`${entry.kind} entry "${entry.id}"`);
      throw e;
    }
    return next?.signEntry(entry) ?? sig ?? '';
  };
  const resign = <T extends { sig?: string }>(
    kind: string,
    rows: Record<string, T>,
  ): Record<string, T> =>
    Object.fromEntries(
      Object.entries(rows).map(([id, row]) => {
        const { sig, ...value } = row;
        return [id, { ...row, sig: check({ id, kind, value }, sig) }];
      }),
    );
  const hooks = Object.fromEntries(
    Object.entries(d.hooks).map(([id, raw]) => {
      const stored = StoredHook.safeParse(raw);
      if (!stored.success)
        throw unverified(`hooks entry "${id}" has a bad shape`);
      const { value, sig } = stored.data;
      return [id, { value, sig: check({ id, kind: 'hooks', value }, sig) }];
    }),
  );
  const roots = d.roots.map((r) => {
    const { sig, ...value } = r;
    return { ...r, sig: check({ id: r.path, kind: 'roots', value }, sig) };
  });
  const system1 =
    d.system1 === undefined
      ? undefined
      : (() => {
          const { sig, ...value } = d.system1;
          return {
            ...value,
            sig: check({ id: 'system1', kind: 'system1', value }, sig),
          };
        })();
  if (d.anchor === undefined) throw unverified('the store names no anchor');
  const { sig: anchorSig, ...location } = d.anchor;
  const anchor = {
    ...d.anchor,
    sig: check({ id: 'anchor', kind: 'anchor', value: location }, anchorSig),
  };
  const productionOrigins = Object.fromEntries(
    Object.entries(d.productionOrigins).map(([id, p]) => [
      id,
      { sig: check({ id, kind: 'productionOrigins', value: {} }, p.sig) },
    ]),
  );
  const doc: TrustStoreDoc = {
    ...d,
    projects: resign('projects', d.projects),
    envs: resign('envs', d.envs),
    profiles: resign('profiles', d.profiles),
    productionOrigins,
    roots,
    hooks,
    anchor,
    ...(system1 === undefined ? {} : { system1 }),
    ownerFingerprint: next?.fingerprint ?? d.ownerFingerprint,
    ownerPublicKey: next?.publicKey.toString('base64') ?? d.ownerPublicKey,
  };
  return doc;
}

/** The count of signed entries per kind in `d`, for the rotation's confirmation screen. */
export const countEntries = (d: TrustStoreDoc): EntryCounts => ({
  projects: Object.keys(d.projects).length,
  roots: d.roots.length,
  envs: Object.keys(d.envs).length,
  profiles: Object.keys(d.profiles).length,
  productionOrigins: Object.keys(d.productionOrigins).length,
  hooks: Object.keys(d.hooks).length,
  anchor: d.anchor === undefined ? 0 : 1,
  system1: d.system1 === undefined ? 0 : 1,
});
