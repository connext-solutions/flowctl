import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { TrustError } from './errors.js';
import {
  beginAnchor,
  chooseAnchor,
  finishAnchor,
  writeAnchor,
} from './anchor.js';
import { assertNotInRepository } from './location.js';
import {
  LOG_FILE,
  newStoreId,
  genesisLine,
  lineHash,
  writeLine,
} from './log.js';
import type { OwnerKey } from './owner-key.js';
import type { TrustStoreDoc } from './schema.js';
import { TrustStore } from './store.js';
import {
  fsyncDir,
  lock,
  logText,
  normalize,
  replaceFile,
  serialize,
  writeExclusive,
} from './store-fs.js';

const STORE_FILE = 'trust.json';

/**
 * Creates the store directory 0700 (refused inside any repository), its `ledgers/` directory 0700 (ADR 0025
 * Amendment 2026-11-02 section 4), its anchor (section 7: the keychain, the Secret Service, or a file in
 * `anchorDir`), its first `trust.log` (an owner-signed `genesis` line and the `write` line of the first document)
 * and its first `trust.json` carrying that head and the owner-signed anchor location, each written
 * `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` with mode 0600 (ADR 0025 section 1).
 *
 * @param anchorDir `trust init --anchor-dir`: where the anchor file goes when no keychain answers.
 * @param replaces the old fingerprint and head a `trust init --replace` genesis records.
 * @throws {TrustError} `store_exists` when a store is already there; `anchor_unavailable` with no keychain and no
 *   `anchorDir`; `trust_tampered` inside a repository; `trust_entry_invalid` for a document the schema refuses.
 */
export function createStoreDoc(
  dir: string,
  doc: TrustStoreDoc,
  key: OwnerKey,
  anchorDir?: string,
  replaces?: { fingerprint: string; head: string },
): void {
  assertNotInRepository(dir);
  if ([STORE_FILE, LOG_FILE, 'ledgers'].some((f) => existsSync(join(dir, f))))
    throw new TrustError(
      'store_exists',
      `A trust store (or what is left of one) already exists in ${dir}; flowctl never overwrites it. Remove it by hand to start over.`,
    );
  const storeId = newStoreId();
  const location = chooseAnchor(storeId, dir, anchorDir);
  const genesis = genesisLine(key, storeId, location, replaces);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  mkdirSync(join(dir, 'ledgers'), { recursive: true, mode: 0o700 });
  const next = normalize({
    ...doc,
    anchor: {
      ...location,
      sig: key.signEntry({ id: 'anchor', kind: 'anchor', value: location }),
    },
  });
  const first = writeLine(genesis, next);
  writeAnchor(location, {
    v: 1,
    storeId,
    ownerFingerprint: key.fingerprint,
    head: lineHash(first),
    seq: first.seq,
    pending: null,
  });
  writeExclusive(join(dir, LOG_FILE), logText([genesis, first]));
  writeExclusive(join(dir, STORE_FILE), serialize(next, lineHash(first)));
  fsyncDir(dir);
}

/**
 * Commits a new version of the store: under the store lock, checks that `trust.json` is still the version `doc` was
 * built from (same `head`), rewrites `trust.log` with one more `write` line, then replaces `trust.json` with `head`
 * set to that line (ADR 0025 sections 1 and 3, "Updates" and "Integrity"). Both files are replaced atomically (a
 * temp file in the same directory written `O_EXCL|O_NOFOLLOW` 0600 and `fsync`ed, then renamed) and the directory
 * is `fsync`ed after each rename, so the log is durable before the document that points into it.
 *
 * @remarks A crash between the two renames leaves one uncommitted `write` line. The next read accepts it, and the
 *   next write keeps it and appends after it, so the log still shows it. With an anchor the write is two-phase
 *   (Amendment 2026-11-02 section 7): the new head is recorded as `pending` before the renames and committed after
 *   them, so a rolled-back or replaced `trust.json` no longer matches the anchor. The anchor entry is copied from the
 *   store on disk, never from `doc`, so a caller cannot drop it. The anchor is a second copy, not a secret: an editor
 *   of the same user who rewrites the store, the log and the anchor is the limit of ADR 0025 section 6.
 * @throws {TrustError} `store_busy` when another flowctl command holds the lock or changed the store since `doc`
 *   was read; `trust_tampered` when `key` is not the pinned owner key (`owner_key_mismatch`) or the store fails its
 *   read checks; `store_unreadable` when the lock cannot be created; `trust_entry_invalid` for a document the schema
 *   refuses.
 */
export function replaceStoreDoc(
  dir: string,
  doc: TrustStoreDoc,
  key: OwnerKey,
): void {
  const release = lock(dir);
  try {
    const now = TrustStore.open(dir);
    if (now.data.head !== doc.head)
      throw new TrustError(
        'store_busy',
        `The trust store in ${dir} changed while this command ran; nothing was changed. Run the command again.`,
      );
    if (now.data.ownerFingerprint !== key.fingerprint)
      throw new TrustError(
        'trust_tampered',
        'The unlocked owner key is not the key this store pins.',
        'owner_key_mismatch',
      );
    commit(dir, now, doc);
  } finally {
    release();
  }
}

/**
 * Sets one `latestRevision` value (ADR 0020 Amendment 2026-11-02 section k, ADR 0042 section 4) and nothing else:
 * under the store lock it reads the store again, lets `guard` judge that read (the `ci` marker and the stored value),
 * and commits that same document with only `latestRevision[entry]` changed, through the same log, rename and anchor
 * steps as {@link replaceStoreDoc}. It takes no owner key because it can change no other section.
 *
 * @internal Reached only through `raiseLatestRevision` (`revision.ts`); `trust/index.ts` does not export it.
 * @param guard throws to refuse the write and returns `false` when there is nothing to change.
 * @throws {TrustError} what `guard` throws; `store_busy`; `trust_tampered` when the store fails its read checks.
 */
export function commitLatestRevision(
  dir: string,
  entry: string,
  revision: number,
  guard: (now: TrustStore) => boolean,
): void {
  const release = lock(dir);
  try {
    const now = TrustStore.open(dir);
    if (!guard(now)) return;
    commit(dir, now, {
      ...now.data,
      latestRevision: { ...now.data.latestRevision, [entry]: revision },
    });
  } finally {
    release();
  }
}

/** The write of {@link replaceStoreDoc} once its checks passed, with the lock held: log line, renames, anchor. */
function commit(dir: string, now: TrustStore, doc: TrustStoreDoc): void {
  const committed = [...now.log];
  const last = committed.at(-1);
  if (last === undefined)
    throw new TrustError('trust_tampered', 'trust.log is empty.', 'log_chain');
  const next = normalize({ ...doc, anchor: now.data.anchor });
  const line = writeLine(last, next);
  const target = { head: lineHash(line), seq: line.seq };
  const anchor = now.anchor;
  const pending = beginAnchor(
    anchor,
    now.data.head,
    target,
    now.data.ownerFingerprint ?? '',
  );
  replaceFile(dir, LOG_FILE, logText([...committed, line]));
  replaceFile(dir, STORE_FILE, serialize(next, target.head));
  try {
    finishAnchor(anchor.location, pending, target);
  } catch (e) {
    throw new TrustError(
      'trust_tampered',
      `The change was saved, but the anchor could not be updated to it (${e instanceof Error ? e.message : String(e)}). Run any flowctl trust command again to finish it.`,
      'anchor_unreachable',
    );
  }
}
