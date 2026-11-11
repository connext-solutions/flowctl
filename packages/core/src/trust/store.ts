import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { TrustError } from './errors.js';
import { assertNotInRepository, assertNotMidReplace } from './location.js';
import { checkAnchor, type StoreAnchor } from './anchor.js';
import type { LogLine } from './log.js';
import { readLog } from './log-read.js';
import { fingerprintOf, type SignedEntry, verifyEntry } from './signing.js';
import { type TrustStoreDoc, TrustStoreSchema } from './schema.js';

const STORE_FILE = 'trust.json';

/**
 * Reads and validates `trust.json` and exposes the trusted values. Opening performs the read-path
 * checks of ADR 0025 section 1: not inside any repository, and a store file that is a regular,
 * non-symlink, single-link file not writable by anyone but its owner. POSIX modes are not verifiable
 * on Windows, so every guarded action is refused there (`platform_unsupported`).
 *
 * @remarks C1 of T1.0: read + validate only. The owner-key signatures on the signed kinds (section
 *   3), the `ci` writability ladder (Amendment section 3), project identity from root commits and the
 *   interactive commands arrive with later chunks. `open(dir)` is the test-only seam; it is exported
 *   from a test-only module, never from `packages/core/src/index.ts` (ADR 0025 section 1).
 * @see docs/adr/0025-trust-store.md
 */
export class TrustStore {
  private constructor(
    readonly dir: string,
    private readonly doc: TrustStoreDoc,
    private readonly ownerKey: Buffer | undefined,
    private readonly lines: readonly LogLine[],
    private readonly uncommitted: 0 | 1,
    private readonly anchored: StoreAnchor,
  ) {}

  /**
   * Opens the store in `dir`.
   *
   * @throws {TrustError} `platform_unsupported` on Windows; `trust_tampered` for a store inside a
   *   repository, a symlinked/hard-linked/world-writable store file, or a `trust.log` that does not match it
   *   (details `log_missing`, `log_head_mismatch`, `log_doc_mismatch`, `log_chain`,
   *   `log_genesis`), or that does not match its anchor (`anchor_unreachable`, `anchor_head_mismatch`, or
   *   `bad_signature` for the anchor entry); `trust_missing` when no store file exists; `store_unreadable` when the store or its log
   *   cannot be read; `trust_entry_invalid` for a bad shape; `rotate_incomplete` while a key rotation left a staged
   *   file in `dir`; `store_replaced` for a store that `trust init --replace` replaced (its log ends with
   *   `replaced`, or the new store is not moved into place yet).
   */
  static open(dir: string): TrustStore {
    if (process.platform === 'win32')
      throw new TrustError(
        'platform_unsupported',
        'flowctl cannot verify trust-store permissions on Windows; guarded actions are refused there.',
      );
    assertNotInRepository(dir);
    assertNoStagedRotation(dir);
    const file = join(dir, STORE_FILE);
    if (!existsSync(file)) assertNotMidReplace(dir);
    if (!existsSync(file))
      throw new TrustError(
        'trust_missing',
        `No trust store at ${file}. Run: flowctl trust init`,
      );
    const raw = readStoreFile(file);
    const parsed = TrustStoreSchema.safeParse(JSON.parse(raw));
    if (!parsed.success)
      throw new TrustError(
        'trust_entry_invalid',
        `The trust store at ${file} is not valid:\n${prettyIssues(parsed.error)}`,
      );
    const key = pinnedKey(file, parsed.data);
    const { log, pending } = readLog(dir, parsed.data, key, readStoreFile);
    const genesis = log[0];
    if (genesis?.kind !== 'genesis')
      throw new TrustError(
        'trust_tampered',
        `${dir}/trust.log does not start with a genesis line.`,
        'log_genesis',
      );
    const anchor = checkAnchor(parsed.data, genesis.body, (value, sig) =>
      verifyEntry(
        key ?? Buffer.alloc(0),
        { id: 'anchor', kind: 'anchor', value },
        sig,
      ),
    );
    return new TrustStore(dir, parsed.data, key, log, pending, anchor);
  }

  /** The store's verified anchor. */
  get anchor(): StoreAnchor {
    return this.anchored;
  }

  /** The verified lines of `trust.log`. */
  get log(): readonly LogLine[] {
    return this.lines;
  }

  /** How many trailing log lines a crash left uncommitted (0 or 1); the next write keeps them and appends after them. */
  get pending(): 0 | 1 {
    return this.uncommitted;
  }

  /** True when the store carries the `ci` marker (ADR 0025 section 2). */
  get isCi(): boolean {
    return this.doc.markers.includes('ci');
  }

  /** True when the store carries the `test` marker (ADR 0025 section 1). */
  get isTest(): boolean {
    return this.doc.markers.includes('test');
  }

  /**
   * The validated document, for the guards that read specific sections.
   *
   * @remarks Entries of the signed kinds (ADR 0025 section 3) are not verified here: a caller must pass
   *   each one through {@link assertSigned} before acting on it.
   */
  get data(): TrustStoreDoc {
    return this.doc;
  }

  /**
   * Refuses an entry of a signed kind unless `signature` is the owner signature of it under the public key
   * pinned in this store (ADR 0025 section 3: verified on every read).
   *
   * @remarks The pinned key sits in the same `trust.json` it protects, so until the anchor of Amendment
   *   2026-11-02 section 7 pins the fingerprint outside the file, a same-uid editor can swap the key and
   *   re-sign every entry. This check therefore detects edits by anyone without the owner key; no guard may
   *   rely on it alone against a same-uid adversary (ADR 0025 section 6).
   * @throws {TrustError} `trust_tampered` with detail `no_owner_key` when the store pins no key, or
   *   `bad_signature` when the signature does not verify.
   */
  assertSigned(entry: SignedEntry, signature: string): void {
    if (this.ownerKey === undefined)
      throw new TrustError(
        'trust_tampered',
        `The trust store in ${this.dir} pins no owner key, so its signed entries cannot be trusted. Run: flowctl trust init`,
        'no_owner_key',
      );
    if (!verifyEntry(this.ownerKey, entry, signature))
      throw new TrustError(
        'trust_tampered',
        `The ${entry.kind} entry "${entry.id}" in ${this.dir} is not signed by the owner key; the store was changed outside flowctl.`,
        'bad_signature',
      );
  }
}

/**
 * The owner public key pinned in the store, checked against `ownerFingerprint`. Both fields are set
 * together or not at all.
 *
 * @throws {TrustError} `trust_tampered` with detail `owner_key_mismatch` when only one is set, the key is
 *   not 32 bytes, or it does not hash to the fingerprint.
 */
function pinnedKey(file: string, doc: TrustStoreDoc): Buffer | undefined {
  const { ownerPublicKey, ownerFingerprint } = doc;
  if (ownerPublicKey === undefined && ownerFingerprint === undefined)
    return undefined;
  const key = Buffer.from(ownerPublicKey ?? '', 'base64');
  if (
    key.length !== 32 ||
    ownerFingerprint === undefined ||
    fingerprintOf(key) !== ownerFingerprint
  )
    throw new TrustError(
      'trust_tampered',
      `The owner key pinned in ${file} does not match its fingerprint; the store was changed outside flowctl.`,
      'owner_key_mismatch',
    );
  return key;
}

/** The files a key rotation stages in the store directory before its commit (Amendment 2026-11-02 section 5). */
export const STAGED_FILES = ['trust.json.new', 'trust.log.new'] as const;

/**
 * Refuses a store directory holding a file a key rotation staged: the store may be between its commit and the log
 * rename, so neither file can be trusted alone.
 *
 * @throws {TrustError} `rotate_incomplete`.
 */
export function assertNoStagedRotation(dir: string): void {
  const staged = STAGED_FILES.find((f) => existsSync(join(dir, f)));
  if (staged !== undefined)
    throw new TrustError(
      'rotate_incomplete',
      `An owner-key rotation of the trust store in ${dir} did not finish (${staged} is still there). Run: flowctl trust key rotate-owner`,
    );
}

/**
 * Opens `file` with `O_NOFOLLOW`, `fstat`s the descriptor and refuses a symlink, a link count above
 * one, or a file writable by group or other, then reads it (ADR 0025 section 1).
 *
 * @throws {TrustError} `trust_tampered` for a symlink, hard link or world-writable file;
 *   `store_unreadable` when it cannot be opened or read.
 */
export function readStoreFile(file: string): string {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ELOOP')
      throw new TrustError(
        'trust_tampered',
        `The trust store file ${file} is a symlink; flowctl never reads the store through a link.`,
      );
    throw new TrustError(
      'store_unreadable',
      `Cannot open the trust store ${file}: ${String(code ?? e)}`,
    );
  }
  try {
    const st = fstatSync(fd);
    if (st.nlink > 1)
      throw new TrustError(
        'trust_tampered',
        `The trust store file ${file} has ${st.nlink} hard links; a second name for it could sit in an unguarded place.`,
      );
    if ((st.mode & 0o022) !== 0)
      throw new TrustError(
        'trust_tampered',
        `The trust store file ${file} is writable by group or other; it must be 0600.`,
      );
    if (st.uid !== userInfo().uid)
      throw new TrustError(
        'trust_tampered',
        `The trust store file ${file} is not owned by the current user; only the owner's store is trusted (ADR 0025 section 1). The CI layout, where another uid owns a read-only store, is validated in a later chunk.`,
      );
    return readFileSync(fd, 'utf8');
  } finally {
    closeSync(fd);
  }
}

function prettyIssues(error: {
  issues: { path: PropertyKey[]; message: string }[];
}): string {
  return error.issues
    .map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
}
