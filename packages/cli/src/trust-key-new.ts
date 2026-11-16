import {
  assertReviewerPassphrase,
  createReviewerKey,
  defaultKeyDir,
  displayText,
  loadOwnerKey,
  type NewKeyTarget,
  planNewKey,
  TrustError,
  type TrustStore,
} from '@flowctl/core';
import type { Values } from './argv.js';
import { keyLines, keyRequest } from './trust-key-opts.js';
import { confirmNonce, openTty } from './trust-tty.js';

/**
 * `flowctl trust key new --person <name> --scope flows|spec --expires <days> [--out <file>]`: on the owner machine,
 * generates a reviewer key, seals it under a passphrase typed twice on `/dev/tty`, writes the key file (default
 * `<home>/.config/flowctl-reviewer-keys/<key id>.key`) and its `.pub`, and registers the public key with an owner
 * signature in one step (ADR 0025 section 3, "Key provisioning").
 *
 * @remarks Every refusal that needs no terminal (person, scope, expiry, a key path inside a repository, the owner-key
 *   directory or the store) comes before the first prompt. Nothing secret is printed: the key id and the file paths.
 * @throws {TrustError} `trust_entry_invalid`, `tty_required`, `confirmation_mismatch` (nonce or the two passphrases),
 *   `key_unlock_failed`, `passphrase_too_short`, `key_exists`, `key_write_failed`, `store_busy`; `trust_tampered`.
 */
export function trustKeyNew(
  store: TrustStore,
  values: Values,
  out: (s: string) => void,
): void {
  const req = keyRequest(values);
  const target: NewKeyTarget = {
    out: values.out,
    excluded: [defaultKeyDir()],
  };
  const place = planNewKey(store, target);
  const tty = openTty();
  try {
    tty.write(
      displayText(
        `\nCreate a reviewer key and register it in ${store.dir}\n${keyLines({ ...req, custody: 'file', expires: `in ${req.days} days` })}Key file:  ${values.out === undefined ? `${place}/<key id>.key` : place}\n\n`,
      ),
    );
    confirmNonce(tty, `create a reviewer key for ${req.person}`);
    const owner = loadOwnerKey(
      defaultKeyDir(),
      tty.ask('Owner-key passphrase: ', { echo: false }),
    );
    const pass = tty.ask(
      'New reviewer-key passphrase (16 characters or more): ',
      {
        echo: false,
      },
    );
    assertReviewerPassphrase(pass);
    if (
      tty.ask('New reviewer-key passphrase again: ', { echo: false }) !== pass
    )
      throw new TrustError(
        'confirmation_mismatch',
        'The two passphrases differ; nothing was changed.',
      );
    const { key, files } = createReviewerKey(store, owner, req, target, pass);
    out(
      displayText(
        `registered reviewer key ${key.id}\n${keyLines({ ...key, expires: key.expiresAt })}Key file:  ${files.keyFile}\nPublic key: ${files.pubFile}\n`,
      ),
    );
  } finally {
    tty.close();
  }
}
