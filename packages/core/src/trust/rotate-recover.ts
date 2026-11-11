import { existsSync, lstatSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { finishAnchor, writeAnchor } from './anchor.js';
import { TrustError } from './errors.js';
import { LOG_FILE, type LogLine } from './log.js';
import { checkHead, verifyLog } from './log-read.js';
import { TrustStoreSchema, type TrustStoreDoc } from './schema.js';
import { STAGED_FILES, TrustStore, readStoreFile } from './store.js';
import { datedName, fsyncDir, lock } from './store-fs.js';

const STORE_FILE = 'trust.json';

const KEY = 'owner.key';
const KEY_NEW = 'owner.key.new';
/** The name `owner.key` is retired to: `owner.key.retired-<UTC date>.<n>` (Amendment 2026-11-02 section 5, step 5). */
export const retiredName = (keyDir: string): string =>
  datedName(keyDir, `${KEY}.retired-`);

/**
 * Retires `owner.key` (when still there) and moves `owner.key.new` into its place: the key renames of rotation step 5,
 * which `trust init --replace` repeats in its step 4. Does nothing without `owner.key.new`.
 *
 * @returns the retired key's file name, or `undefined` when there was nothing to retire.
 */
export function swapKeys(keyDir: string): string | undefined {
  if (!existsSync(join(keyDir, KEY_NEW))) return undefined;
  let retired: string | undefined;
  try {
    lstatSync(join(keyDir, KEY));
    retired = retiredName(keyDir);
    renameSync(join(keyDir, KEY), join(keyDir, retired));
  } catch (e) {
    if (!(e instanceof Error && 'code' in e && e.code === 'ENOENT')) throw e;
  }
  renameSync(join(keyDir, KEY_NEW), join(keyDir, KEY));
  fsyncDir(keyDir);
  return retired;
}

/**
 * The end of step 5, after `trust.log.new` became `trust.log`: retires `owner.key` (when still there), moves
 * `owner.key.new` into its place, then commits the anchor's pending head with the new owner fingerprint. Each step
 * is skipped when a crashed run already did it, so a rerun finishes the rotation.
 *
 * @returns the retired key's file name, or `undefined` when an earlier run retired it.
 * @throws {TrustError} `trust_tampered` (`anchor_unreachable`) when the anchor cannot be written, and any refusal of
 *   {@link TrustStore.open}.
 */
export function finishRotation(
  storeDir: string,
  keyDir: string,
): string | undefined {
  const retired = swapKeys(keyDir);
  settleAnchor(TrustStore.open(storeDir));
  return retired;
}

/**
 * Commits an anchor whose pending head is the head on disk: the second phase of a write or rotation that ended
 * before it. A rotation runs it before it creates `owner.key.new`, so a pending head never outlives the rotation
 * that set it and recovery cannot mistake a later rotation's leftover key for that one's.
 *
 * @param rerun the command the error tells the owner to run again.
 * @returns whether the anchor was pending.
 * @throws {TrustError} `trust_tampered` (`anchor_unreachable`) when the anchor cannot be written.
 */
export function settleAnchor(
  store: TrustStore,
  rerun = 'flowctl trust key rotate-owner',
): boolean {
  const { location, record } = store.anchor;
  const pending = record.pending;
  if (pending === null || pending.head !== store.data.head) return false;
  try {
    finishAnchor(
      location,
      record,
      pending,
      store.data.ownerFingerprint ?? record.ownerFingerprint,
    );
  } catch (e) {
    throw new TrustError(
      'trust_tampered',
      `A change is saved, but the anchor could not be updated (${e instanceof Error ? e.message : String(e)}). Run ${rerun} again to finish it.`,
      'anchor_unreachable',
    );
  }
  return true;
}

/** What {@link recoverRotation} did. */
export type Recovery = 'none' | 'rolled_back' | 'completed';

/**
 * Ends a rotation a crash interrupted (ADR 0025 Amendment 2026-11-02 section 5, "Crash recovery"), with no
 * passphrase. Before the commit (`trust.json` still matches `trust.log`) every staged file is deleted and the
 * anchor's pending head dropped; after it, the staged log is renamed into place when needed and the keys and the
 * anchor are finished.
 *
 * @remarks A rotation is taken as committed only when the anchor still holds the store's head as pending and the
 *   log ends with a `rotate` line to the pinned key and its `write` line. Every rotation commits a pending anchor
 *   before it creates `owner.key.new` ({@link settleAnchor}), so a leftover new key of a later rotation rolls back
 *   instead of replacing the pinned key. With nothing staged, a pending anchor at the head is committed; the result
 *   is `completed` when it closed a rotation.
 * @throws {TrustError} `rotate_incomplete` while a `trust init --replace` left `<store>.new` (its key is not a
 *   rotation's); `trust_tampered` (detail `rotate_state`) when the files match no state a rotation passes through; `store_busy` while another command holds the lock; any refusal of {@link TrustStore.open}.
 */
export function recoverRotation(storeDir: string, keyDir: string): Recovery {
  if (existsSync(`${storeDir}.new`))
    throw new TrustError(
      'rotate_incomplete',
      `A replacement of the trust store did not finish (${storeDir}.new is still there). Run flowctl trust init --replace to start it over.`,
    );
  if (!existsSync(join(storeDir, STORE_FILE))) return 'none';
  const release = lock(storeDir);
  try {
    const staged = STAGED_FILES.filter((f) => existsSync(join(storeDir, f)));
    const keyNew = existsSync(join(keyDir, KEY_NEW));
    if (staged.length === 0 && !keyNew) {
      const store = TrustStore.open(storeDir);
      const rotation = store.log.at(-2);
      return settleAnchor(store) &&
        store.pending === 0 &&
        rotation?.kind === 'rotate' &&
        rotation.body.to === store.data.ownerFingerprint
        ? 'completed'
        : 'none';
    }
    const doc = readDoc(storeDir);
    if (consistent(readStoreFile(join(storeDir, LOG_FILE)), doc)) {
      if (staged.length === 0 && committed(storeDir, doc)) {
        finishRotation(storeDir, keyDir);
        return 'completed';
      }
      rollBack(storeDir, keyDir);
      return 'rolled_back';
    }
    const logNew = join(storeDir, `${LOG_FILE}.new`);
    const lines =
      staged.length === 1 && staged[0] === `${LOG_FILE}.new`
        ? consistent(readStoreFile(logNew), doc)
        : undefined;
    const rotation = lines?.at(-2);
    if (
      rotation?.kind !== 'rotate' ||
      rotation.body.to !== doc.ownerFingerprint
    )
      throw new TrustError(
        'trust_tampered',
        `The trust store in ${storeDir} matches no step of an owner-key rotation; it was changed outside flowctl. Restore it from a backup.`,
        'rotate_state',
      );
    renameSync(logNew, join(storeDir, LOG_FILE));
    fsyncDir(storeDir);
    finishRotation(storeDir, keyDir);
    return 'completed';
  } finally {
    release();
  }
}

/**
 * `trust.json` parsed without the log and anchor checks of {@link TrustStore.open}, which a store between the commit
 * and the log rename fails.
 *
 * @throws {TrustError} `trust_entry_invalid`; the refusals of {@link readStoreFile}.
 */
function readDoc(storeDir: string): TrustStoreDoc {
  let raw: unknown;
  try {
    raw = JSON.parse(readStoreFile(join(storeDir, STORE_FILE)));
  } catch (e) {
    if (e instanceof TrustError) throw e;
    raw = undefined;
  }
  const parsed = TrustStoreSchema.safeParse(raw);
  if (!parsed.success)
    throw new TrustError(
      'trust_entry_invalid',
      `The trust store in ${storeDir} is not valid.`,
    );
  return parsed.data;
}

/** The log lines when `text` verifies and commits `doc` (a crashed write may trail it), else `undefined`. */
function consistent(text: string, doc: TrustStoreDoc): LogLine[] | undefined {
  try {
    const lines = verifyLog(text, {
      publicKey: Buffer.from(doc.ownerPublicKey ?? '', 'base64'),
      fingerprint: doc.ownerFingerprint ?? '',
    });
    checkHead(lines, doc);
    return lines;
  } catch (e) {
    if (e instanceof TrustError) return undefined;
    throw e;
  }
}

/** Whether the store on disk is a committed rotation whose anchor and keys are not finished yet. */
function committed(storeDir: string, doc: TrustStoreDoc): boolean {
  const store = TrustStore.open(storeDir);
  const rotation = store.log.at(-2);
  return (
    store.anchor.record.pending?.head === doc.head &&
    rotation?.kind === 'rotate' &&
    rotation.body.to === doc.ownerFingerprint
  );
}

/**
 * Deletes every staged file and drops the anchor's pending head, restoring the state before the rotation.
 *
 * @remarks `owner.key.new` goes first: a crash part-way then leaves store files only, which roll back again, never
 *   a lone new key next to a pending anchor.
 */
export function rollBack(storeDir: string, keyDir: string): void {
  rmSync(join(keyDir, KEY_NEW), { force: true });
  fsyncDir(keyDir);
  for (const f of STAGED_FILES) rmSync(join(storeDir, f), { force: true });
  fsyncDir(storeDir);
  const store = TrustStore.open(storeDir);
  const { location, record } = store.anchor;
  if (record.pending !== null && record.head === store.data.head)
    writeAnchor(location, { ...record, pending: null });
}
