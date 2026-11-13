import {
  defaultKeyDir,
  displayText,
  loadOwnerKey,
  planRevokeKey,
  revokeReviewerKey,
  validateReason,
  type TrustStore,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { keyLines } from './trust-key-opts.js';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * `flowctl trust key revoke <key id> [--reason <text>]`: shows the key, asks for the nonce and the owner-key
 * passphrase, and appends an owner-signed revocation. The key entry and every earlier revocation stay; the key's
 * approvals fail from the next store read.
 *
 * @throws {TrustError} `trust_entry_invalid` (no such key or already revoked, before any prompt; a refused reason),
 *   `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`; `trust_tampered`.
 */
export function trustKeyRevoke(
  store: TrustStore,
  id: string,
  values: Values,
  out: (s: string) => void,
): void {
  const key = planRevokeKey(store, id);
  validateReason(values.reason);
  const tty = openTty();
  try {
    tty.write(
      displayText(
        `\nRevoke reviewer key ${key.id}\n${keyLines({ ...key, expires: key.expiresAt })}Its approvals then fail from the next store read.\n\n`,
      ),
    );
    confirmNonce(tty, `revoke reviewer key ${key.id.slice(0, 12)}`);
    const owner = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    const done = revokeReviewerKey(store, owner, key.id, values.reason);
    out(`revoked reviewer key ${done.keyId}\n`);
  } finally {
    tty.close();
  }
}
