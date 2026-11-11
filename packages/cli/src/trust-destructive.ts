import {
  confirmLine,
  confirmReadContext,
  defaultKeyDir,
  displayText,
  type LoadedConfig,
  loadOwnerKey,
  readConfirmEntries,
  revokeConfirmEntry,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * `flowctl trust revoke destructive <id>`: shows the entry and every `mutate` entry that depends on it in the fixed
 * line format, asks for the nonce and the owner-key passphrase, and removes them (ADR 0024 section 5, ADR 0025
 * section 3). A replay then refuses the requests they authorised.
 *
 * @throws {TrustError} `trust_entry_invalid` when the store has no entry `id` (before any prompt) or is marked `ci`,
 *   `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`; `trust_tampered` for a key that is not
 *   the pinned one or an entry changed outside flowctl.
 */
export function trustRevokeDestructive(
  cfg: LoadedConfig,
  store: TrustStore,
  id: string,
  out: (s: string) => void,
): void {
  const read = readConfirmEntries(store, confirmReadContext(cfg));
  const lines = read.entries
    .filter((e) => e.id === id || (e.kind === 'mutate' && e.ledgerFrom === id))
    .map(confirmLine);
  for (const i of read.invalid)
    if (i.id === id) lines.push(`${i.id} (invalid: ${i.problem})`);
  if (read.expired.includes(id)) lines.push(`${id} (expired)`);
  if (lines.length === 0)
    throw new TrustError(
      'trust_entry_invalid',
      `The trust store has no destructiveConfirm entry "${displayText(id)}"; nothing was changed.`,
    );
  const tty = openTty();
  try {
    tty.write(
      `\nrevoke these destructive confirmations:\n${lines.map((l) => `  ${displayText(l)}`).join('\n')}\nA replay then refuses the requests they authorised.\n`,
    );
    confirmNonce(tty, `revoke ${id}`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    for (const removed of revokeConfirmEntry(store, key, id))
      out(`revoked ${removed}\n`);
  } finally {
    tty.close();
  }
}
