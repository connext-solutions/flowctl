import { existsSync, readdirSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, join, parse } from 'node:path';
import { TrustError } from './errors.js';

/**
 * The default store directory `<passwd home>/.config/flowctl`, where the home comes from the passwd
 * entry (`getpwuid_r(geteuid())`, which `os.userInfo().homedir` wraps), never the environment.
 *
 * @throws {TrustError} `platform_unsupported` when the process has no passwd entry (a container with
 *   a random uid), since there is no compiled default and no fallback (ADR 0025 section 1).
 * @see docs/adr/0025-trust-store.md
 */
export function defaultStoreDir(): string {
  let home: string;
  try {
    home = userInfo().homedir;
  } catch {
    throw new TrustError(
      'platform_unsupported',
      'No passwd entry for the current uid; flowctl has no fallback store location. Run as a user with a home directory.',
    );
  }
  if (home === '' || home === undefined)
    throw new TrustError(
      'platform_unsupported',
      'The passwd entry has no home directory; flowctl cannot locate its trust store.',
    );
  return join(home, '.config', 'flowctl');
}

/**
 * The default owner-key directory `<passwd home>/.config/flowctl-owner-key`: next to the store, never inside
 * it, so the key and the store it signs are separate directories (ADR 0025 Amendment 2026-11-02 section 5).
 *
 * @throws {TrustError} `platform_unsupported` like {@link defaultStoreDir}.
 */
export function defaultKeyDir(): string {
  return `${defaultStoreDir()}-owner-key`;
}

/**
 * Refuses a store directory inside, or tracked by, any enclosing repository: any ancestor holding a
 * `.git` entry (ADR 0025 section 1). There is no exemption for a home that is itself a repo.
 *
 * @remarks `realpath` and mount-point normalisation (ADR 0025 section 1) are applied by the caller
 *   that resolves the store path; this walk compares the path as given.
 * @throws {TrustError} `trust_tampered` when an ancestor contains `.git`.
 */
export function assertNotInRepository(dir: string): void {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, '.git')))
      throw new TrustError(
        'trust_tampered',
        `The trust store at ${dir} is inside a git repository (${current}/.git); it must live outside any repository. Choose another location.`,
      );
    const parent = dirname(current);
    if (parent === current || parent === parse(current).root) {
      if (existsSync(join(parent, '.git')))
        throw new TrustError(
          'trust_tampered',
          `The trust store at ${dir} is inside a git repository (${parent}/.git); it must live outside any repository.`,
        );
      return;
    }
    current = parent;
  }
}

/**
 * Refuses a store directory caught between the two renames of `trust init --replace` (ADR 0025 Amendment 2026-11-02
 * section 6, step 4): the store is gone, `<store>.new` is the new store and `<store>.replaced-*` the old one.
 *
 * @throws {TrustError} `store_replaced` with the renames that finish it.
 */
export function assertNotMidReplace(storeDir: string): void {
  if (existsSync(storeDir) || !existsSync(`${storeDir}.new`)) return;
  const stem = `${basename(storeDir)}.replaced-`;
  let names: string[];
  try {
    names = readdirSync(dirname(storeDir));
  } catch {
    return;
  }
  if (names.some((n) => n.startsWith(stem)))
    throw new TrustError(
      'store_replaced',
      `The trust store in ${storeDir} was replaced, but the new store was not moved into place. If ${storeDir}.new is the store that trust init --replace prepared, rename it to ${storeDir}.`,
    );
}
