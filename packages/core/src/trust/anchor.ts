import { canonicalJson } from './canonical.js';
import { TrustError } from './errors.js';
import {
  readAnchor,
  writeAnchor,
  type AnchorLocation,
  type AnchorRecord,
} from './anchor-io.js';

export {
  ANCHOR_BINARIES,
  AnchorLocationSchema,
  chooseAnchor,
  deleteAnchor,
  readAnchor,
  writeAnchor,
  type AnchorLocation,
  type AnchorRecord,
} from './anchor-io.js';

/** A store's verified anchor: where it lives and what it held when the store was opened. */
export interface StoreAnchor {
  location: AnchorLocation;
  record: AnchorRecord;
}

/** What a store needs for the anchor checks: its `anchor` entry, `head`, owner pin and log genesis. */
interface AnchorInput {
  anchor?: AnchorLocation & { sig: string };
  head?: string;
  ownerFingerprint?: string;
}

const mismatch = (why: string): TrustError =>
  new TrustError(
    'trust_tampered',
    `The trust store does not match its anchor: ${why}. trust.json was rolled back or replaced outside flowctl; restore it, or remove the store and run flowctl trust init.`,
    'anchor_head_mismatch',
  );

/**
 * Verifies a store against its anchor on read (ADR 0025 Amendment 2026-11-02 section 7): the `anchor` entry is
 * owner-signed, the record names this store, and the head on disk is the anchor's `head` (then the record also names
 * this owner key) or its `pending` head (a write that crashed between its two phases; a key rotation is pending
 * there too, so the record still names the previous key).
 *
 * @param verify checks an owner-key signature over a `trust.json` entry.
 * @param genesis the store id and anchor location the owner-signed genesis line of the log recorded.
 * @returns the verified anchor.
 * @throws {TrustError} `trust_tampered` with detail `bad_signature`, `anchor_unreachable` or `anchor_head_mismatch`
 *   (also when the anchor entry was removed or re-pointed).
 */
export function checkAnchor(
  doc: AnchorInput,
  genesis: { storeId: string; anchor: AnchorLocation },
  verify: (value: AnchorLocation, sig: string) => boolean,
): StoreAnchor {
  if (doc.anchor === undefined)
    throw mismatch(
      'trust.json no longer names the anchor its log was created with',
    );
  const { sig, ...location } = doc.anchor;
  if (canonicalJson(location) !== canonicalJson(genesis.anchor))
    throw mismatch(
      'trust.json names another anchor than its log was created with',
    );
  const storeId = genesis.storeId;
  if (!verify(location, sig))
    throw new TrustError(
      'trust_tampered',
      'The anchor entry of the trust store is not signed by the owner key.',
      'bad_signature',
    );
  const record = readAnchor(location);
  if (record.storeId !== storeId)
    throw mismatch('the anchor belongs to another store');
  const committed = doc.head === record.head;
  const pending = record.pending !== null && doc.head === record.pending.head;
  if (!committed && !pending)
    throw mismatch('its head is not the one the anchor recorded');
  if (committed && record.ownerFingerprint !== doc.ownerFingerprint)
    throw mismatch('the anchor names another owner key');
  return { location, record };
}

/**
 * Phase 1 of a store write (Amendment 2026-11-02 section 7): reconciles a pending head left by a crash with the head
 * on disk (taking the owner fingerprint of the store on disk, which a pending rotation may have changed), then
 * records the head about to be written as `pending`.
 *
 * @param ownerFingerprint the fingerprint the store on disk pins.
 *
 * @returns the record as written, for {@link finishAnchor}.
 * @throws {TrustError} `trust_tampered` (`anchor_head_mismatch`) when the head on disk is neither the anchor's head
 *   nor its pending head; `anchor_unreachable` when the anchor cannot be written.
 */
export function beginAnchor(
  a: StoreAnchor,
  onDisk: string | undefined,
  next: { head: string; seq: number },
  ownerFingerprint: string,
): AnchorRecord {
  let rec = a.record;
  if (rec.pending !== null && onDisk === rec.pending.head)
    rec = {
      ...rec,
      ownerFingerprint,
      head: rec.pending.head,
      seq: rec.pending.seq,
      pending: null,
    };
  else if (onDisk !== rec.head)
    throw mismatch('its head is not the one the anchor recorded');
  const pending = { ...rec, pending: next };
  writeAnchor(a.location, pending);
  return pending;
}

/**
 * Phase 2 of a store write: the new head is committed in the anchor.
 *
 * @param ownerFingerprint the owner key the new head is signed with (a rotation changes it).
 * @throws {TrustError} `trust_tampered` (`anchor_unreachable`) when the anchor cannot be written.
 */
export function finishAnchor(
  loc: AnchorLocation,
  rec: AnchorRecord,
  next: { head: string; seq: number },
  ownerFingerprint: string = rec.ownerFingerprint,
): void {
  writeAnchor(loc, {
    ...rec,
    ownerFingerprint,
    head: next.head,
    seq: next.seq,
    pending: null,
  });
}
