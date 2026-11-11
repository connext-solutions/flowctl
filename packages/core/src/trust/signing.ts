import { createHash, createPublicKey, verify } from 'node:crypto';
import { canonicalJson } from './canonical.js';

const ENTRY_PREFIX = 'flowctl-entry-v1\n';
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

/** A signed `trust.json` entry: what the owner signature covers (ADR 0025 Amendment 2026-11-02 s.5). */
export interface SignedEntry {
  id: string;
  kind: string;
  value: unknown;
}

/** Lowercase hex sha256 of the raw 32-byte Ed25519 public key; the value pinned as `ownerFingerprint`. */
export const fingerprintOf = (publicKey: Buffer): string =>
  createHash('sha256').update(publicKey).digest('hex');

/**
 * The bytes a signed `trust.log` line of `kind` covers: `"flowctl-<kind>-v1\n"` + the canonical line without its
 * signature fields (ADR 0025 Amendment 2026-11-02 section 5). The prefix keeps them apart from entry signatures.
 */
export const lineMessage = (kind: string, unsigned: unknown): Buffer =>
  Buffer.from(`flowctl-${kind}-v1\n${canonicalJson(unsigned)}`);

/**
 * The bytes an owner signature covers: `"flowctl-entry-v1\n"` + canonical `{id, kind, value}`. The entry
 * signature does not cover the chain head (ADR 0025 Amendment 2026-11-02 s.5).
 */
export const entryBytes = (entry: SignedEntry): Buffer =>
  Buffer.from(
    ENTRY_PREFIX +
      canonicalJson({ id: entry.id, kind: entry.kind, value: entry.value }),
  );

/**
 * True when `signature` (base64) is the owner signature of `entry` under `publicKey` (32 raw bytes).
 * A malformed key or signature is `false`, never an exception.
 */
export const verifyEntry = (
  publicKey: Buffer,
  entry: SignedEntry,
  signature: string,
): boolean => verifyMessage(publicKey, entryBytes(entry), signature);

/**
 * True when `signature` (base64) is an Ed25519 signature of `message` under `publicKey` (32 raw bytes). The caller
 * builds `message` with its own domain prefix (a `trust.log` line). A malformed key or signature is `false`.
 */
export function verifyMessage(
  publicKey: Buffer,
  message: Buffer,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_ED25519, publicKey]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, message, key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
