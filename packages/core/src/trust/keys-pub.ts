import { createPublicKey } from 'node:crypto';
import { TrustError } from './errors.js';

const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');
const MAX_BYTES = 4096;
const SSH_NAME = Buffer.from('ssh-ed25519');
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

const invalid = (why: string): TrustError =>
  new TrustError(
    'trust_entry_invalid',
    `The file is not an Ed25519 public key (${why}); expected a PEM "PUBLIC KEY" or an OpenSSH "ssh-ed25519" line.`,
    'public_key_invalid',
  );

/** The 32 raw bytes of an Ed25519 SPKI DER, or `undefined` for any other DER. */
function rawFromSpki(der: Buffer): Buffer | undefined {
  if (
    der.length !== SPKI_ED25519.length + 32 ||
    !der.subarray(0, SPKI_ED25519.length).equals(SPKI_ED25519)
  )
    return undefined;
  return Buffer.from(der.subarray(SPKI_ED25519.length));
}

/** The 32 raw bytes of an OpenSSH `ssh-ed25519` key blob (`string name`, `string key`), or `undefined`. */
function rawFromSshBlob(blob: Buffer): Buffer | undefined {
  if (blob.length !== 4 + SSH_NAME.length + 4 + 32) return undefined;
  if (blob.readUInt32BE(0) !== SSH_NAME.length) return undefined;
  if (!blob.subarray(4, 4 + SSH_NAME.length).equals(SSH_NAME)) return undefined;
  if (blob.readUInt32BE(4 + SSH_NAME.length) !== 32) return undefined;
  return Buffer.from(blob.subarray(8 + SSH_NAME.length));
}

/**
 * The raw 32-byte Ed25519 public key in a key file's text: a PEM `PUBLIC KEY` (SPKI) or an OpenSSH `ssh-ed25519`
 * line, as `ssh-keygen -t ed25519` writes in its `.pub` file.
 *
 * @remarks A bare base64 string is refused on purpose: 32 bytes of a private seed look the same as 32 bytes of a
 *   public key. Anything that mentions private key material is refused before it is parsed, so a mistaken private key
 *   file is never read further and never echoed.
 * @throws {TrustError} `trust_entry_invalid` (detail `private_key_given` or `public_key_invalid`).
 */
export function parsePublicKey(text: string): Buffer {
  if (text.length > MAX_BYTES) throw invalid('file too large');
  if (/PRIVATE KEY/.test(text))
    throw new TrustError(
      'trust_entry_invalid',
      'The file holds private key material. Give flowctl the public key file only; keep the private key to yourself.',
      'private_key_given',
    );
  const pem =
    /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+?)\s+-----END PUBLIC KEY-----\s*$/.exec(
      text.trim(),
    );
  let raw: Buffer | undefined;
  if (pem?.[1] !== undefined)
    raw = rawFromSpki(Buffer.from(pem[1].replace(/\s+/g, ''), 'base64'));
  else {
    const line = /^ssh-ed25519 ([^\s]+)(?: [^\r\n]*)?$/.exec(text.trim());
    if (line?.[1] !== undefined && BASE64.test(line[1]))
      raw = rawFromSshBlob(Buffer.from(line[1], 'base64'));
  }
  if (raw === undefined) throw invalid('wrong format or not Ed25519');
  try {
    createPublicKey({
      key: Buffer.concat([SPKI_ED25519, raw]),
      format: 'der',
      type: 'spki',
    });
  } catch {
    throw invalid('not a valid key');
  }
  return raw;
}

/** The PEM `PUBLIC KEY` text of a raw Ed25519 public key, as written to a `.pub` file. */
export const publicKeyPem = (publicKey: Buffer): string =>
  `-----BEGIN PUBLIC KEY-----\n${Buffer.concat([SPKI_ED25519, publicKey]).toString('base64')}\n-----END PUBLIC KEY-----\n`;
