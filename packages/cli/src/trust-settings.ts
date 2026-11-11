import {
  addProductionOrigin,
  checkProductionOrigin,
  checkProjectSetting,
  defaultKeyDir,
  displayText,
  loadOwnerKey,
  setProjectSetting,
  type ProjectSetting,
  type TrustStore,
} from '@flowctl/core';
import { domainToUnicode } from 'node:url';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * An origin as a confirmation screen shows it (ADR 0025 section 3): escaped, and, when its host is an
 * internationalised name (`xn--`), followed by the Unicode form so a look-alike host is easy to spot.
 *
 * @example originDisplay('https://xn--bcher-kva.example') // 'https://xn--bcher-kva.example (bücher.example)'
 * @internal
 */
export function originDisplay(origin: string): string {
  let host = '';
  try {
    host = new URL(origin).hostname;
  } catch {
    return displayText(origin);
  }
  const unicode = host.includes('xn--') ? domainToUnicode(host) : '';
  return displayText(
    unicode === '' || unicode === host ? origin : `${origin} (${unicode})`,
  );
}

/**
 * `flowctl trust add default-env <env>`, `language <code>`, `locale <locale>`: shows the old and the new value of
 * this project's setting, asks for the nonce on the terminal, and signs the project entry with the owner key (ADR
 * 0025 section 3).
 *
 * @throws {TrustError} `trust_entry_invalid` (an env not classed, classed production or on a production host, a bad
 *   code, the value already set), `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`;
 *   `trust_tampered` for a key that is not the pinned one or a store changed outside flowctl.
 */
export function trustSetProject(
  store: TrustStore,
  project: string,
  s: ProjectSetting,
  out: (s: string) => void,
): void {
  const old = checkProjectSetting(store, project, s);
  const label = {
    defaultEnv: 'default env',
    language: 'language',
    locale: 'locale',
  }[s.field];
  const tty = openTty();
  try {
    tty.write(
      displayText(
        `\nproject ${project}: ${label} ${old ?? '(not set)'} -> ${s.value}\n`,
      ),
    );
    confirmNonce(tty, `set the ${label} of ${project} to ${s.value}`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    setProjectSetting(store, key, project, s);
    out(`set ${label} of ${project} to ${s.value}\n`);
  } finally {
    tty.close();
  }
}

/**
 * `flowctl trust add production-origin <origin>`: shows the origin (and its ASCII form when it differs), asks for the
 * nonce, and adds it signed with the owner key. A production origin is guarded on every request (ADR 0024 section 2).
 *
 * @throws {TrustError} `trust_entry_invalid` (not an origin, its host already covered, an env on the host classed
 *   lower), `tty_required`, `confirmation_mismatch`, `key_unlock_failed`, `store_busy`; `trust_tampered` for a key
 *   that is not the pinned one or a store changed outside flowctl.
 */
export function trustAddProductionOrigin(
  store: TrustStore,
  origin: string,
  out: (s: string) => void,
): void {
  checkProductionOrigin(store, origin);
  const tty = openTty();
  try {
    tty.write(
      `\nproduction origin: ${originDisplay(origin)}\nIt covers every scheme and port of this host. Runs are blocked from writing there, and read-only replay needs its own entry.\n`,
    );
    confirmNonce(tty, `add ${origin} as a production origin`);
    const key = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    addProductionOrigin(store, key, origin);
    out(`added production origin ${origin}\n`);
  } finally {
    tty.close();
  }
}
