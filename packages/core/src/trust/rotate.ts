import { createHash } from 'node:crypto';
import { existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { assertCanWrite } from './admin.js';
import { beginAnchor } from './anchor.js';
import { TrustError } from './errors.js';
import { LOG_FILE, lineHash, writeLine, type LogLine } from './log.js';
import { createOwnerKey, type OwnerKey } from './owner-key.js';
import { finishRotation, rollBack, settleAnchor } from './rotate-recover.js';
import {
  countEntries,
  openToVerify,
  resignStore,
  type EntryCounts,
  type Unverified,
} from './rotate-sign.js';
import {
  fsyncDir,
  lock,
  logText,
  normalize,
  serialize,
  writeExclusive,
} from './store-fs.js';
import { TrustStore, readStoreFile } from './store.js';

const STORE_FILE = 'trust.json';
const KEY_NEW = 'owner.key.new';

/** What the rotation's one confirmation screen shows (owner decision of 2026-11-06). */
export interface RotationPlan {
  counts: EntryCounts;
  /** sha256 of `trust.json` as read. */
  storeSha256: string;
  /** The head the rotation must still find; a change in between refuses with `store_busy`. */
  head: string;
  fingerprint: string;
}

/**
 * Verifies the whole store with its pinned key and describes it for the confirmation screen
 * (ADR 0025 Amendment 2026-11-02 section 5, step 1).
 *
 * @throws {TrustError} `rotate_unverified` for an entry that does not verify; any refusal of {@link TrustStore.open}.
 */
export const planRotation = (storeDir: string): RotationPlan =>
  planFor(storeDir, 'rotate_unverified');

/**
 * Verifies the whole store before `trust init --replace` and describes what it drops (Amendment 2026-11-02 section 6,
 * step 1).
 *
 * @throws {TrustError} `replace_unverified` for an entry that does not verify; any refusal of {@link TrustStore.open}.
 */
export const planReplace = (storeDir: string): RotationPlan =>
  planFor(storeDir, 'replace_unverified');

function planFor(storeDir: string, refusal: Unverified): RotationPlan {
  const store = openToVerify(storeDir, refusal);
  resignStore(store, undefined, refusal);
  const text = readStoreFile(join(storeDir, STORE_FILE));
  return {
    counts: countEntries(store.data),
    storeSha256: createHash('sha256').update(text).digest('hex'),
    head: store.data.head ?? '',
    fingerprint: store.data.ownerFingerprint ?? '',
  };
}

/**
 * A point in {@link rotateOwner} after which a test stops it as a crash would: `owner.key.new` written (`key`),
 * everything staged and the anchor pending (`staged`), `trust.json` renamed (`commit`), `trust.log` renamed (`log`).
 *
 * @internal
 */
export type RotationStep = 'key' | 'staged' | 'commit' | 'log';

/**
 * Rotates the owner key (ADR 0025 Amendment 2026-11-02 section 5): stages `owner.key.new`, `trust.log.new` (the log,
 * a `rotate` line signed by both keys, and the `write` line of the re-signed document) and `trust.json.new`, records
 * the new head as pending in the anchor, renames `trust.json.new` over `trust.json` (the only commit point), then
 * finishes with {@link finishRotation} after renaming the log.
 *
 * @remarks A failure before the commit removes what was staged (`rollBack`), so the store stays usable; a crash
 *   there leaves the files for `recoverRotation`. `owner.key.new` is created before that scope, so a refusal to
 *   create it (another process made one) never deletes a file this run did not write. A pending anchor of an earlier write or rotation is committed
 *   first (`settleAnchor`).
 * @param oldKey the unlocked current owner key.
 * @param newPassphrase the passphrase of the new key, read from `/dev/tty` by the caller.
 * @returns the new fingerprint and the retired key's file name.
 * @throws {TrustError} `rotate_incomplete` when an earlier rotation left staged files (run `recoverRotation`);
 *   `store_busy` when the store changed since `plan` or another command holds the lock; `trust_entry_invalid` for
 *   a store marked `ci`; `trust_tampered` (`owner_key_mismatch`) when `oldKey` is not the pinned key; `rotate_unverified`; `passphrase_too_short`;
 *   `trust_tampered` (`anchor_unreachable`) after the commit when the anchor could not be finished (a rerun ends it).
 */
export const rotateOwner = (
  storeDir: string,
  keyDir: string,
  plan: Pick<RotationPlan, 'head'>,
  oldKey: OwnerKey,
  newPassphrase: string,
): { fingerprint: string; retired: string | undefined } =>
  rotateOwnerUntil(storeDir, keyDir, plan, oldKey, newPassphrase);

/**
 * {@link rotateOwner} with a crash point for the recovery tests.
 *
 * @param crashAfter stop after this step, leaving the files as a crash there would.
 * @internal
 */
export function rotateOwnerUntil(
  storeDir: string,
  keyDir: string,
  plan: Pick<RotationPlan, 'head'>,
  oldKey: OwnerKey,
  newPassphrase: string,
  crashAfter?: RotationStep,
): { fingerprint: string; retired: string | undefined } {
  const step = (at: RotationStep): void => {
    if (crashAfter === at) throw new Error(`simulated crash after ${at}`);
  };
  const release = lock(storeDir);
  try {
    if (existsSync(join(keyDir, KEY_NEW)))
      throw new TrustError(
        'rotate_incomplete',
        `An owner-key rotation did not finish (${join(keyDir, KEY_NEW)} is still there). Run: flowctl trust key rotate-owner`,
      );
    const store = TrustStore.open(storeDir);
    if (store.data.head !== plan.head)
      throw new TrustError(
        'store_busy',
        `The trust store in ${storeDir} changed after it was shown; nothing was changed. Run the command again.`,
      );
    assertCanWrite(store, oldKey);
    resignStore(store);
    settleAnchor(store);
    const settled = TrustStore.open(storeDir);
    const newKey = createOwnerKey(keyDir, newPassphrase, KEY_NEW);
    try {
      step('key');
      stage(settled, storeDir, oldKey, newKey);
      step('staged');
      renameSync(
        join(storeDir, `${STORE_FILE}.new`),
        join(storeDir, STORE_FILE),
      );
    } catch (e) {
      if (crashAfter === undefined) undoStage(storeDir, keyDir, e);
      throw e;
    }
    fsyncDir(storeDir);
    step('commit');
    renameSync(join(storeDir, `${LOG_FILE}.new`), join(storeDir, LOG_FILE));
    fsyncDir(storeDir);
    step('log');
    return {
      fingerprint: TrustStore.open(storeDir).data.ownerFingerprint ?? '',
      retired: finishRotation(storeDir, keyDir),
    };
  } finally {
    release();
  }
}

/**
 * Removes what a failed rotation staged before its commit, so the store stays usable.
 *
 * @throws {TrustError} `rotate_incomplete` naming both failures when the removal fails too; the next
 *   `recoverRotation` rolls back whatever is left.
 */
function undoStage(storeDir: string, keyDir: string, cause: unknown): void {
  try {
    rollBack(storeDir, keyDir);
  } catch (e) {
    throw new TrustError(
      'rotate_incomplete',
      `The owner-key rotation failed (${describe(cause)}) and its staged files could not be removed (${describe(e)}). Nothing was committed; run flowctl trust key rotate-owner to roll it back.`,
    );
  }
}

const describe = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Steps 2 and 3 after the new key exists: writes `trust.log.new` and `trust.json.new`, then records the new head as
 * pending in the anchor.
 *
 * @remarks The log keeps a trailing uncommitted line, as every write does (see `checkHead`).
 */
function stage(
  store: TrustStore,
  storeDir: string,
  oldKey: OwnerKey,
  newKey: OwnerKey,
): void {
  const doc = normalize(resignStore(store, newKey));
  const lines = [...store.log];
  const rotate = rotateLine(lines, oldKey, newKey);
  const write = writeLine(rotate, doc);
  const target = { head: lineHash(write), seq: write.seq };
  writeExclusive(
    join(storeDir, `${LOG_FILE}.new`),
    logText([...lines, rotate, write]),
  );
  writeExclusive(
    join(storeDir, `${STORE_FILE}.new`),
    serialize(doc, target.head),
  );
  fsyncDir(storeDir);
  beginAnchor(store.anchor, store.data.head, target, oldKey.fingerprint);
}

/** The `rotate` line after `lines`, signed by both keys over `"flowctl-rotate-v1\n"` + the unsigned line. */
function rotateLine(
  lines: LogLine[],
  oldKey: OwnerKey,
  newKey: OwnerKey,
): LogLine {
  const last = lines.at(-1);
  if (last === undefined)
    throw new TrustError('trust_tampered', 'trust.log is empty.', 'log_chain');
  const unsigned = {
    seq: last.seq + 1,
    prev: lineHash(last),
    kind: 'rotate' as const,
    body: {
      from: oldKey.fingerprint,
      to: newKey.fingerprint,
      oldPublicKey: oldKey.publicKey.toString('base64'),
      newPublicKey: newKey.publicKey.toString('base64'),
    },
  };
  return {
    ...unsigned,
    sigOld: oldKey.signLine('rotate', unsigned),
    sigNew: newKey.signLine('rotate', unsigned),
  };
}
