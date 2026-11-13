import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
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

const unreadable = (file: string): TrustError =>
  new TrustError(
    'trust_entry_invalid',
    `Cannot read the public key file ${displayText(file)}.`,
  );

/**
 * Reads a public key file safely: opened `O_NOFOLLOW|O_NONBLOCK` (a symlink is refused and a FIFO cannot block the
 * open), `fstat`ed on the descriptor to be a regular file, and read from that descriptor for at most 4 KiB.
 */
function readPublicFile(file: string): string {
  let fd: number;
  try {
    fd = openSync(
      file,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch {
    throw unreadable(file);
  }
  try {
    if (!fstatSync(fd).isFile()) throw unreadable(file);
    const buf = Buffer.alloc(MAX_PUBLIC_FILE + 1);
    let n = 0;
    while (n < buf.length) {
      const got = readSync(fd, buf, n, buf.length - n, null);
      if (got === 0) break;
      n += got;
    }
    if (n > MAX_PUBLIC_FILE)
      throw new TrustError(
        'trust_entry_invalid',
        `${displayText(file)} is too large to be a public key file.`,
      );
    return buf.toString('utf8', 0, n);
  } catch (e) {
    if (e instanceof TrustError) throw e;
    throw unreadable(file);
  } finally {
    closeSync(fd);
  }
}

/**
 * `flowctl trust key add <public key file> --person <name> --scope flows|spec --expires <days> --custody hardware|file`:
 * registers a public key the owner received (a PEM `PUBLIC KEY` or an OpenSSH `ssh-ed25519` line) with an owner
 * signature. `--custody` is an unverifiable declaration by the owner of where the private half lives; flowctl records
 * it as `declared-file` or `declared-hardware` and says so. No unencrypted file key is ever accepted, and a file
 * holding private key material is refused unread.
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
        `\nRegister a reviewer key in ${store.dir}\nKey id:    ${id}\n${keyLines({ ...req, custody, expires: `in ${req.days} days` })}You declare that its private half is ${custody === 'declared-hardware' ? 'on a hardware device' : 'in a passphrase-encrypted file'}; this is declared by owner, not verified, and flowctl cannot check it.\n\n`,
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
