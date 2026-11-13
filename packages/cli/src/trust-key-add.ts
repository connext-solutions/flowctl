import { readFileSync, statSync } from 'node:fs';
import {
  addReviewerKey,
  defaultKeyDir,
  displayText,
  loadOwnerKey,
  parsePublicKey,
  reviewerKeyId,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { keyCustody, keyLines, keyRequest } from './trust-key-opts.js';
import { confirmNonce, openTty } from './trust-tty.js';

const MAX_PUBLIC_FILE = 4096;

function readPublicFile(file: string): string {
  try {
    if (statSync(file).size > MAX_PUBLIC_FILE)
      throw new TrustError(
        'trust_entry_invalid',
        `${displayText(file)} is too large to be a public key file.`,
      );
    return readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof TrustError) throw e;
    throw new TrustError(
      'trust_entry_invalid',
      `Cannot read the public key file ${displayText(file)}.`,
    );
  }
}

/**
 * `flowctl trust key add <public key file> --person <name> --scope flows|spec --expires <days> --custody hardware|file`:
 * registers a public key the owner received (a PEM `PUBLIC KEY` or an OpenSSH `ssh-ed25519` line) with an owner
 * signature. `--custody` is the owner's statement of where the private half lives; no unencrypted file key is ever
 * accepted, and a file holding private key material is refused unread.
 *
 * @throws {TrustError} `trust_entry_invalid` (options, an unreadable or private or malformed key file, a key
 *   already registered), `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`; `trust_tampered`.
 */
export function trustKeyAdd(
  store: TrustStore,
  file: string,
  values: Values,
  out: (s: string) => void,
): void {
  const req = keyRequest(values);
  const custody = keyCustody(values);
  const publicKey = parsePublicKey(readPublicFile(file));
  const id = reviewerKeyId(publicKey);
  const tty = openTty();
  try {
    tty.write(
      displayText(
        `\nRegister a reviewer key in ${store.dir}\nKey id:    ${id}\n${keyLines({ ...req, custody, expires: `in ${req.days} days` })}You state that its private half is ${custody === 'hardware' ? 'on a hardware device' : 'in a passphrase-encrypted file'}; flowctl cannot check that.\n\n`,
      ),
    );
    confirmNonce(tty, `register key ${id.slice(0, 12)} for ${req.person}`);
    const owner = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    const key = addReviewerKey(store, owner, publicKey, req, custody);
    out(
      displayText(
        `registered reviewer key ${key.id}\n${keyLines({ ...key, expires: key.expiresAt })}`,
      ),
    );
  } finally {
    tty.close();
  }
}
