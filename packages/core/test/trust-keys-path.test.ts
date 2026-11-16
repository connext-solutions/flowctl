import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReviewerKeyPath,
  defaultReviewerKeyDir,
} from '../src/trust/index.js';
import { kindOf } from './rotate-fixture.js';

const base = () => mkdtempSync(join(tmpdir(), 'flowctl-keypath-'));
const repoIn = (dir: string): string => {
  const repo = join(dir, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  return repo;
};

describe('reviewer key paths (T1.15)', () => {
  it('passes an ordinary path outside any repository and returns its real path', () => {
    const dir = base();
    expect(assertReviewerKeyPath(join(dir, 'keys', 'a.key'), [])).toMatch(
      /keys\/a\.key$/,
    );
  });

  it('refuses a path inside a repository, even in a directory that does not exist yet', () => {
    const repo = repoIn(base());
    for (const path of [join(repo, 'a.key'), join(repo, 'not', 'yet', 'a.key')])
      expect(kindOf(() => assertReviewerKeyPath(path, []))).toBe(
        'trust_entry_invalid:key_path_in_repository',
      );
  });

  it('refuses a symlink whose target is inside a repository', () => {
    const dir = base();
    const repo = repoIn(dir);
    const link = join(dir, 'link');
    symlinkSync(repo, link);
    for (const path of [join(link, 'a.key'), join(link, 'new', 'a.key')])
      expect(kindOf(() => assertReviewerKeyPath(path, []))).toBe(
        'trust_entry_invalid:key_path_in_repository',
      );
  });

  it('refuses the owner-key directory and the store directory, by real path too', () => {
    const dir = base();
    const ownerDir = join(dir, 'owner-key');
    const storeDir = join(dir, 'store');
    mkdirSync(ownerDir);
    mkdirSync(storeDir);
    const alias = join(dir, 'alias');
    symlinkSync(ownerDir, alias);
    for (const path of [
      join(ownerDir, 'a.key'),
      join(storeDir, 'deep', 'a.key'),
      storeDir,
      join(alias, 'a.key'),
    ])
      expect(
        kindOf(() => assertReviewerKeyPath(path, [ownerDir, storeDir])),
      ).toBe('trust_entry_invalid:key_path_in_key_dir');
    expect(
      kindOf(() =>
        assertReviewerKeyPath(join(dir, 'store-other', 'a.key'), [
          ownerDir,
          storeDir,
        ]),
      ),
    ).toBeUndefined();
  });

  it('compares excluded directories case-insensitively where the filesystem is', () => {
    const dir = base();
    const ownerDir = join(dir, 'Owner-Key');
    mkdirSync(ownerDir);
    const probe = join(dir, 'owner-key');
    if (!existsSync(probe)) return; // a case-sensitive filesystem: nothing to prove
    expect(
      kindOf(() => assertReviewerKeyPath(join(probe, 'a.key'), [ownerDir])),
    ).toBe('trust_entry_invalid:key_path_in_key_dir');
    expect(
      kindOf(() =>
        assertReviewerKeyPath(join(dir, 'OWNER-KEY', 'new', 'a.key'), [
          ownerDir,
        ]),
      ),
    ).toBe('trust_entry_invalid:key_path_in_key_dir');
  });

  it('keeps the default directory next to the store and the owner-key directory', () => {
    expect(defaultReviewerKeyDir()).toMatch(
      /\/\.config\/flowctl-reviewer-keys$/,
    );
  });
});
