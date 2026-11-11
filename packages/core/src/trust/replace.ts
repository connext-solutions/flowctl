import { existsSync, renameSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { assertCanWrite } from './admin.js';
import {
  type AnchorLocation,
  beginAnchor,
  deleteAnchor,
  finishAnchor,
} from './anchor.js';
import { anchorDirFor } from './anchor-file.js';
import { TrustError } from './errors.js';
import { type InitAnswers, initTrust } from './init.js';
import { LOG_FILE, lineHash, type LogLine } from './log.js';
import { createOwnerKey, type OwnerKey } from './owner-key.js';
import { discardStaged, stagedStoreDir } from './replace-abandon.js';
import { settleAnchor, swapKeys } from './rotate-recover.js';
import { finishByHand } from './log-read.js';
import { openToVerify, resignStore } from './rotate-sign.js';
import { datedName, fsyncDir, lock, logText, replaceFile } from './store-fs.js';
import { TrustStore } from './store.js';

const KEY_NEW = 'owner.key.new';

/** What the new store of `trust init --replace` holds: the `trust init` answers (body section 3, "First use"). */
export interface ReplaceInit {
  project: string;
  projectDir: string;
  flowsDir: string;
  answers: InitAnswers;
  anchorDir?: string;
}

/**
 * A point in {@link replaceStoreUntil} after which a test stops it as a crash would: the new store and key prepared
 * (`prepared`), the old log ended with `replaced` (`marked`), the keys swapped (`keys`).
 *
 * @internal
 */
export type ReplaceStep = 'prepared' | 'marked' | 'keys';

/** What a finished replacement reports. */
export interface Replaced {
  fingerprint: string;
  /** Where the old store now is: `<store>.replaced-<UTC date>.<n>`. */
  replacedDir: string;
  retired: string | undefined;
  /** False when the old anchor record could not be deleted; it names an id no store has and is ignored. */
  oldAnchorRemoved: boolean;
}

/**
 * `trust init --replace` (ADR 0025 Amendment 2026-11-02 section 6): verifies the old store in full, prepares a new
 * key (`owner.key.new`) and a complete new store in `<store>.new` by the `trust init` rules, with a genesis line that
 * names the old fingerprint and head and its own anchor; ends the old `trust.log` with a `replaced` line signed by the
 * old key; then moves the keys and both store directories into place and deletes the old anchor record.
 *
 * @remarks Nothing is carried over. The keys move before the directories: once the old log ends with `replaced`,
 *   the old store refuses with `store_replaced` whatever key is in place, and a crash between the directory renames
 *   leaves no `owner.key.new` that `trust key rotate-owner` could mistake for its own. The store lock is released
 *   before the directories move, so the lock file does not travel with the old store; after step 3 every other
 *   command refuses the old store with `store_replaced`, so none can step in.
 * @throws {TrustError} `replace_unverified`; `store_busy` when the store changed since it was shown or a previous
 *   attempt is still there; `trust_entry_invalid` for a `ci` store or bad answers; `trust_tampered`
 *   (`owner_key_mismatch`) for a key that is not the pinned one; `passphrase_too_short`; `anchor_unavailable`; the
 *   refusals of {@link initTrust}.
 */
export const replaceStore = (
  storeDir: string,
  keyDir: string,
  plan: { head: string },
  oldKey: OwnerKey,
  newPassphrase: string,
  init: ReplaceInit,
): Replaced =>
  replaceStoreUntil(storeDir, keyDir, plan, oldKey, newPassphrase, init);

/**
 * {@link replaceStore} with a crash point for the recovery tests.
 *
 * @internal
 */
export function replaceStoreUntil(
  storeDir: string,
  keyDir: string,
  plan: { head: string },
  oldKey: OwnerKey,
  newPassphrase: string,
  init: ReplaceInit,
  crashAfter?: ReplaceStep,
): Replaced {
  const step = (at: ReplaceStep): void => {
    if (crashAfter === at) throw new Error(`simulated crash after ${at}`);
  };
  const staged = stagedStoreDir(storeDir);
  const release = lock(storeDir);
  let fingerprint: string;
  let location: AnchorLocation;
  try {
    if (existsSync(staged) || existsSync(join(keyDir, KEY_NEW)))
      throw new TrustError(
        'store_busy',
        `An earlier replacement or rotation left ${existsSync(staged) ? staged : join(keyDir, KEY_NEW)}; nothing was changed. Run the command again.`,
      );
    let store = openToVerify(storeDir, 'replace_unverified');
    if (store.data.head !== plan.head)
      throw new TrustError(
        'store_busy',
        `The trust store in ${storeDir} changed after it was shown; nothing was changed. Run the command again.`,
      );
    assertCanWrite(store, oldKey);
    resignStore(store, undefined, 'replace_unverified');
    if (settleAnchor(store, 'flowctl trust init --replace'))
      store = TrustStore.open(storeDir);
    if (init.anchorDir !== undefined) anchorDirFor(init.anchorDir, storeDir);
    location = store.anchor.location;
    const newKey = createOwnerKey(keyDir, newPassphrase, KEY_NEW);
    fingerprint = newKey.fingerprint;
    let storeId: string;
    try {
      initTrust({
        ...init,
        storeDir: staged,
        key: newKey,
        replaces: { fingerprint: oldKey.fingerprint, head: plan.head },
      });
      const genesis = TrustStore.open(staged).log[0];
      if (genesis?.kind !== 'genesis')
        throw new TrustError(
          'trust_tampered',
          'The new store has no genesis.',
          'log_genesis',
        );
      storeId = genesis.body.storeId;
    } catch (e) {
      if (crashAfter === undefined) undoPrepare(storeDir, keyDir, e);
      throw e;
    }
    step('prepared');
    if (!existsSync(staged) || !existsSync(join(keyDir, KEY_NEW)))
      throw new TrustError(
        'store_busy',
        `The prepared store or key disappeared while this command ran; the old store is unchanged. Run the command again.`,
      );
    markReplaced(store, oldKey, fingerprint, storeId);
  } finally {
    release();
  }
  step('marked');
  const retired = swapKeys(keyDir);
  step('keys');
  if (!existsSync(staged))
    throw new TrustError(
      'store_replaced',
      `The old store is marked replaced, but the prepared store ${staged} is gone. Restore it from a backup, or remove ${storeDir} and run flowctl trust init.`,
    );
  const replacedDir = join(
    dirname(storeDir),
    datedName(dirname(storeDir), `${basename(storeDir)}.replaced-`),
  );
  renameSync(storeDir, replacedDir);
  renameSync(staged, storeDir);
  fsyncDir(dirname(storeDir));
  return {
    fingerprint,
    replacedDir,
    retired,
    oldAnchorRemoved: deleteAnchor(location),
  };
}

/**
 * Removes what a failed step 2 prepared, so the old store and key stay usable.
 *
 * @throws {TrustError} `replace_unverified` naming both failures when the removal fails too; what is left is
 *   `owner.key.new` at most, which `flowctl trust key rotate-owner` clears.
 */
function undoPrepare(storeDir: string, keyDir: string, cause: unknown): void {
  try {
    discardStaged(storeDir, keyDir);
  } catch (e) {
    throw new TrustError(
      'replace_unverified',
      `The replacement failed (${describe(cause)}) and what it prepared could not be removed (${describe(e)}). The old store is unchanged; run flowctl trust init --replace again, or flowctl trust key rotate-owner to clear a leftover owner.key.new.`,
    );
  }
}

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Step 3: ends the old log with the `replaced` line and moves the old anchor to it in two phases, so a log with the
 * line cut off again no longer matches the anchor (`anchor_head_mismatch`) while the old anchor record exists.
 *
 * @throws {TrustError} `store_replaced` when the line is written but the anchor could not be finished: the store is
 *   replaced either way, and the swap is finished by hand.
 */
function markReplaced(
  store: TrustStore,
  oldKey: OwnerKey,
  newFingerprint: string,
  newStoreId: string,
): void {
  const line = replacedLine(store.log, oldKey, newFingerprint, newStoreId);
  const target = { head: lineHash(line), seq: line.seq };
  const pending = beginAnchor(
    store.anchor,
    store.data.head,
    target,
    oldKey.fingerprint,
  );
  replaceFile(store.dir, LOG_FILE, logText([...store.log, line]));
  try {
    finishAnchor(store.anchor.location, pending, target);
  } catch (e) {
    throw new TrustError(
      'store_replaced',
      `The old store is marked replaced, but its anchor could not be updated (${e instanceof Error ? e.message : String(e)}). ${finishByHand(store.dir)}`,
    );
  }
}

/** The `replaced` line that ends the old log, signed by the old key over the new fingerprint and store id. */
function replacedLine(
  lines: readonly LogLine[],
  oldKey: OwnerKey,
  newFingerprint: string,
  newStoreId: string,
): LogLine {
  const last = lines.at(-1);
  if (last === undefined)
    throw new TrustError('trust_tampered', 'trust.log is empty.', 'log_chain');
  const unsigned = {
    seq: last.seq + 1,
    prev: lineHash(last),
    kind: 'replaced' as const,
    body: { newFingerprint, newStoreId },
  };
  return { ...unsigned, sig: oldKey.signLine('replaced', unsigned) };
}
