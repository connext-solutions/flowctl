import {
  abandonReplace,
  defaultKeyDir,
  defaultStoreDir,
  displayText,
  type LoadedConfig,
  loadOwnerKey,
  planReplace,
  replaceStore,
  TrustError,
  validateInit,
} from '@flowctl/core';
import {
  askInitAnswers,
  describeAnswers,
  envCandidates,
  projectName,
} from './trust-init.js';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * `flowctl trust init --replace` (ADR 0025 Amendment 2026-11-02 section 6): first deletes what a replacement that
 * crashed before its commit left, then verifies the old store, shows what it holds (all of it is dropped), runs the
 * `trust init` interview for the new store, asks one nonce, the current passphrase and a new one twice, and replaces
 * the store.
 *
 * @remarks Every step runs on `/dev/tty`. The old store is kept as `<store>.replaced-<UTC date>.<n>`.
 * @throws {TrustError} `tty_required`, `trust_missing` (no store to replace), `replace_unverified`, `store_replaced`,
 *   `confirmation_mismatch`, `key_unlock_failed`, `passphrase_too_short`, `anchor_unavailable`, `store_busy`,
 *   `trust_entry_invalid`, `trust_tampered`.
 */
export function trustReplace(
  cfg: LoadedConfig,
  out: (s: string) => void,
  anchorDir?: string,
): void {
  const storeDir = defaultStoreDir();
  const keyDir = defaultKeyDir();
  const tty = openTty();
  try {
    if (abandonReplace(storeDir, keyDir))
      out('removed an interrupted replacement; starting over\n');
    const plan = planReplace(storeDir);
    const counts = Object.entries(plan.counts)
      .map(([kind, n]) => `  ${kind.padEnd(18)} ${n}`)
      .join('\n');
    tty.write(
      displayText(
        `\nReplace the trust store ${storeDir}\nCurrent key:       ${plan.fingerprint}\ntrust.json sha256: ${plan.storeSha256}\nNothing is carried over; these entries are dropped (hook consents are given again):\n${counts}\nThe old store is kept next to it as ${storeDir}.replaced-<date>.<n>.\n\n`,
      ),
    );
    const project = projectName(cfg.root);
    const answers = askInitAnswers(tty, envCandidates(cfg));
    const init = {
      project,
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      answers,
      anchorDir,
    };
    validateInit({ ...init, storeDir });
    tty.write(describeAnswers(answers));
    confirmNonce(tty, 'replace the trust store');
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
    const done = replaceStore(storeDir, keyDir, plan, oldKey, pass, init);
    out(
      `replaced trust store ${storeDir}\nnew owner key fingerprint ${done.fingerprint}\nthe old store is kept as ${done.replacedDir}\n${done.oldAnchorRemoved ? '' : 'the old anchor record could not be deleted; it names no store and is ignored\n'}`,
    );
  } finally {
    tty.close();
  }
}
