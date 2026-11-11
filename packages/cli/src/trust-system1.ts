import {
  addSystem1,
  defaultKeyDir,
  displayText,
  loadOwnerKey,
  planSystem1,
  type TrustedSystem1,
  type TrustStore,
} from '@flowctl/core';
import { confirmNonce, openTty } from './trust-tty.js';

const show = (s: TrustedSystem1 | undefined): string =>
  s === undefined
    ? '  (none: System 1 is limited only by env class)\n'
    : `  hosts:    ${s.allowedHosts.join(', ')}\n  key vars: ${s.apiKeyEnvs.join(', ')}\n  envs:     ${s.allowedEnvs.join(', ')}\n`;

/**
 * `flowctl trust add system1 <host:port> <KEY_ENV> <env...>`: shows the store's `system1` section before and after,
 * asks for the nonce, and signs the new section with the owner key (ADR 0025 section 2, `system1`). From then on a
 * repo `system1.baseUrl`, `apiKeyEnv` or `allowedEnvs` outside the section turns System 1 off (ADR 0024 section 1).
 *
 * @throws {TrustError} `trust_entry_invalid` (not `host:port`, not a variable name, an env not trusted or production,
 *   nothing new), `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`; `trust_tampered` for a
 *   key that is not the pinned one or a store changed outside flowctl.
 */
export function trustAddSystem1(
  store: TrustStore,
  args: string[],
  out: (s: string) => void,
): void {
  const [host = '', apiKeyEnv = '', ...envs] = args;
  const add = { host, apiKeyEnv, envs };
  const { before, after } = planSystem1(store, add);
  const tty = openTty();
  try {
    tty.write(
      displayText(
        `\nSystem 1 on this machine, now:\n${show(before)}after:\n${show(after)}System 1 sends page text to the endpoint; allow only hosts covered by your data agreement (ADR 0005).\n`,
      ),
    );
    confirmNonce(
      tty,
      `allow System 1 at ${host} with ${apiKeyEnv} in ${envs.join(', ')}`,
    );
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    addSystem1(store, key, add);
    out(
      `allowed System 1 at ${after.allowedHosts.join(', ')} with ${after.apiKeyEnvs.join(', ')} in ${after.allowedEnvs.join(', ')}\n`,
    );
  } finally {
    tty.close();
  }
}
