import {
  defaultKeyDir,
  defaultStoreDir,
  displayText,
  loadOwnerKey,
  planRotation,
  recoverRotation,
  rotateOwner,
  TrustError,
} from '@flowctl/core';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * `flowctl trust key rotate-owner` (ADR 0025 Amendment 2026-11-02 section 5): first finishes or rolls back a rotation
 * a crash interrupted, then shows one screen (the count of signed entries per kind and the sha256 of `trust.json`),
 * asks one nonce, the current passphrase and the new one twice, and rotates the owner key.
 *
 * @remarks Every step runs on `/dev/tty`, including the recovery, which changes the store too. A rotation that
 *   recovery completed is the one the owner asked for before the crash, so the command stops there.
 * @throws {TrustError} `tty_required`, `confirmation_mismatch` (wrong nonce, or the two new passphrases differ),
 *   `key_unlock_failed`, `passphrase_too_short`, `rotate_unverified`, `store_busy`, `trust_tampered`.
 */
export function trustRotateOwner(out: (s: string) => void): void {
  const storeDir = defaultStoreDir();
  const keyDir = defaultKeyDir();
  const tty = openTty();
  try {
    const recovered = recoverRotation(storeDir, keyDir);
    if (recovered === 'completed') {
      out(
        'finished an interrupted owner-key rotation; the new key is in place\n',
      );
      return;
    }
    if (recovered === 'rolled_back')
      out(
        'rolled back an interrupted owner-key rotation; the current key is unchanged\n',
      );
    const plan = planRotation(storeDir);
    const counts = Object.entries(plan.counts)
      .map(([kind, n]) => `  ${kind.padEnd(18)} ${n}`)
      .join('\n');
    tty.write(
      displayText(
        `\nRotate the owner key of ${storeDir}\nCurrent key:     ${plan.fingerprint}\nKey directory:   ${keyDir}\ntrust.json sha256: ${plan.storeSha256}\nEntries to re-sign (no entry content changes):\n${counts}\n\n`,
      ),
    );
    confirmNonce(tty, 'rotate the owner key');
    const oldKey = loadOwnerKey(
      keyDir,
      tty.ask('Current owner-key passphrase: ', { echo: false }),
    );
    const pass = tty.ask('New passphrase (16 characters or more): ', {
      echo: false,
    });
    if (tty.ask('New passphrase again: ', { echo: false }) !== pass)
      throw new TrustError(
        'confirmation_mismatch',
        'The new passphrases differ; nothing was changed.',
      );
    const done = rotateOwner(storeDir, keyDir, plan, oldKey, pass);
    out(
      `rotated the owner key: ${plan.fingerprint} -> ${done.fingerprint}\n${done.retired === undefined ? '' : `the old key file is kept as ${keyDir}/${done.retired}\n`}`,
    );
  } finally {
    tty.close();
  }
}
