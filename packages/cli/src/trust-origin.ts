import {
  addEnvOrigin,
  checkEnvOrigin,
  defaultKeyDir,
  loadOwnerKey,
  type TrustStore,
  TrustError,
} from '@flowctl/core';
import { originDisplay } from './trust-settings.js';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * `flowctl trust add origin <env> <visit|call> <origin>`: shows the env and the origin (with its Unicode form for an
 * internationalised host), asks for the nonce, and adds the origin to the env's `visitOrigins` or `callOrigins`,
 * signed with the owner key. Runs on the env may then open (`visit`) or call (`call`) it (ADR 0024 section 3).
 *
 * @throws {TrustError} `trust_entry_invalid` (not `visit` or `call`, and every refusal of `checkEnvOrigin`),
 *   `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`; `trust_tampered` for a key that is
 *   not the pinned one or a store changed outside flowctl.
 */
export function trustAddOrigin(
  store: TrustStore,
  args: string[],
  out: (s: string) => void,
): void {
  const [env = '', set = '', origin = ''] = args;
  if (set !== 'visit' && set !== 'call')
    throw new TrustError(
      'trust_entry_invalid',
      `"${set}" is not visit or call: visit lets pages of the env open the origin, call lets them send requests to it.`,
    );
  const current = checkEnvOrigin(store, env, set, origin);
  const tty = openTty();
  try {
    tty.write(
      `\nenv ${env} (${originDisplay(current.origin)}, ${current.class})\nadd to its ${set} origins: ${originDisplay(origin)}\n${set === 'visit' ? 'Pages of this env may then open it.' : 'Pages of this env may then send requests to it, cookies included.'}\n`,
    );
    confirmNonce(tty, `add ${origin} to the ${set} origins of ${env}`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    addEnvOrigin(store, key, env, set, origin);
    out(`added ${new URL(origin).origin} to the ${set} origins of ${env}\n`);
  } finally {
    tty.close();
  }
}
