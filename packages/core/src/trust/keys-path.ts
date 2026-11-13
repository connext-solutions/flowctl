import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { TrustError } from './errors.js';
import { assertNotInRepository, defaultStoreDir } from './location.js';

/**
 * The default directory of reviewer key files, `<passwd home>/.config/flowctl-reviewer-keys`: next to the store and
 * the owner-key directory, never inside either (ADR 0025 section 3, "Key provisioning").
 *
 * @throws {TrustError} `platform_unsupported` like {@link defaultStoreDir}.
 */
export const defaultReviewerKeyDir = (): string =>
  `${defaultStoreDir()}-reviewer-keys`;

/**
 * `path` made absolute with every symlink resolved. A path that does not exist yet is resolved through its nearest
 * existing ancestor and the missing names are appended, so a not-yet-created directory below a symlink or a repository
 * is judged where it will really land.
 */
export function realPathOf(path: string): string {
  const full = resolve(path);
  const missing: string[] = [];
  let current = full;
  while (!existsSync(current) && dirname(current) !== current) {
    missing.unshift(basename(current));
    current = dirname(current);
  }
  return join(realpathSync(current), ...missing);
}

const within = (dir: string, path: string): boolean => {
  const rel = relative(dir, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !rel.startsWith('/'))
  );
};

/**
 * The real path a reviewer key file will be written to, after the refusals of ADR 0025 section 3: not inside any
 * repository (judged on the real path, and on the path as written), not inside an excluded directory (the owner-key
 * directory and the store directory, compared by real path).
 *
 * @param excluded directories the key may not be written in or under, e.g. `[ownerKeyDir, storeDir]`.
 * @throws {TrustError} `trust_entry_invalid` with detail `key_path_in_key_dir` for an excluded directory, or
 *   `key_path_in_repository` for a path in a repository (see {@link assertNotInRepository}).
 */
export function assertReviewerKeyPath(
  path: string,
  excluded: readonly string[],
): string {
  const real = realPathOf(path);
  for (const p of [resolve(path), real])
    try {
      assertNotInRepository(p);
    } catch {
      throw new TrustError(
        'trust_entry_invalid',
        `The reviewer key path ${path} is inside a git repository; a key must live outside any repository.`,
        'key_path_in_repository',
      );
    }
  for (const dir of excluded)
    if (within(realPathOf(dir), real) || within(resolve(dir), resolve(path)))
      throw new TrustError(
        'trust_entry_invalid',
        `The reviewer key path ${path} is inside ${dir}, which holds the owner key or the trust store; choose another place.`,
        'key_path_in_key_dir',
      );
  return real;
}
