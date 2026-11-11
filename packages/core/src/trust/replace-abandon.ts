import { existsSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { type AnchorLocation, deleteAnchor } from './anchor.js';
import { TrustError } from './errors.js';
import { openToVerify } from './rotate-sign.js';
import { assertNotMidReplace } from './location.js';
import { datedName, fsyncDir, lock } from './store-fs.js';
import { TrustStore } from './store.js';

const KEY_NEW = 'owner.key.new';

/** Where `trust init --replace` prepares the new store: `<store>.new`, next to the store. */
export const stagedStoreDir = (storeDir: string): string => `${storeDir}.new`;

/**
 * Starts a replacement that crashed before it marked the old store over (ADR 0025 Amendment 2026-11-02 section 6,
 * "Crash outcomes"): deletes `<store>.new` and its anchor record, and sets `owner.key.new` aside. Needs no passphrase.
 *
 * @returns whether there was anything to remove.
 * @throws {TrustError} `store_replaced` when the old store was already marked, or the swap stopped between its two
 *   directory renames (finish it by hand);
 *   `replace_unverified` when the old store does not verify; `store_busy` while another command holds the lock.
 */
export function abandonReplace(storeDir: string, keyDir: string): boolean {
  if (!existsSync(storeDir)) {
    assertNotMidReplace(storeDir);
    return false;
  }
  if (!existsSync(stagedStoreDir(storeDir))) return false;
  const release = lock(storeDir);
  try {
    return discardStaged(storeDir, keyDir);
  } finally {
    release();
  }
}

/**
 * {@link abandonReplace} under a lock the caller holds; `replaceStore` calls it when its step 2 fails.
 *
 * @remarks `owner.key.new` is renamed to `owner.key.abandoned-<UTC date>.<n>`, never deleted: if it is not the
 *   replacement's key after all (a rotation that stopped after its commit), the owner can still put it back. The
 *   staged anchor record is deleted only when it is the staged store's own (its id differs from the old store's and,
 *   for a file, its real path differs too), so an edited `<store>.new` cannot make flowctl delete the live anchor. A
 *   staged store that does not verify leaves its anchor record behind; it names an id no store has and is ignored.
 */
export function discardStaged(storeDir: string, keyDir: string): boolean {
  const staged = stagedStoreDir(storeDir);
  const keyNew = join(keyDir, KEY_NEW);
  if (!existsSync(staged) && !existsSync(keyNew)) return false;
  const old = openToVerify(storeDir, 'replace_unverified');
  if (existsSync(staged)) {
    const own = stagedAnchor(staged);
    if (own !== undefined && ownAnchor(own, old)) deleteAnchor(own.location);
  }
  if (existsSync(keyNew)) {
    renameSync(keyNew, join(keyDir, datedName(keyDir, 'owner.key.abandoned-')));
    fsyncDir(keyDir);
  }
  rmSync(staged, { recursive: true, force: true });
  fsyncDir(dirname(storeDir));
  return true;
}

/** The staged store's anchor and id when that store verifies; a staged store that does not touches no anchor. */
function stagedAnchor(
  staged: string,
): { location: AnchorLocation; storeId: string } | undefined {
  try {
    const store = TrustStore.open(staged);
    const genesis = store.log[0];
    return genesis?.kind === 'genesis'
      ? { location: store.anchor.location, storeId: genesis.body.storeId }
      : undefined;
  } catch (e) {
    if (e instanceof TrustError) return undefined;
    throw e;
  }
}

/** Whether `own` is the staged store's own anchor and not the old store's. */
function ownAnchor(
  own: { location: AnchorLocation; storeId: string },
  old: TrustStore,
): boolean {
  const genesis = old.log[0];
  if (genesis?.kind !== 'genesis' || genesis.body.storeId === own.storeId)
    return false;
  const loc = own.location;
  if (loc.kind !== 'file') return loc.locator === own.storeId;
  const oldLoc = old.anchor.location;
  return (
    basename(loc.locator) === `${own.storeId}.anchor` &&
    (oldLoc.kind !== 'file' || real(loc.locator) !== real(oldLoc.locator))
  );
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};
