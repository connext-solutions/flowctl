import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { TrustError } from './errors.js';
import { HOOK_PATH } from './hookrun/index.js';

/** How long one identity git call may take. */
const GIT_TIMEOUT_MS = 10_000;

/** Why an identity cannot be computed: the `detail` of `identity_unverifiable`. */
type Unverifiable =
  | 'not_a_repository'
  | 'broken_git_link'
  | 'alternates'
  | 'grafts'
  | 'shallow'
  | 'replace_refs'
  | 'no_commit'
  | 'git_failed';

const unverifiable = (
  dir: string,
  detail: Unverifiable,
  why: string,
): TrustError =>
  new TrustError(
    'identity_unverifiable',
    `The repository identity of ${dir} cannot be computed: ${why}. flowctl trusts a project by its git root commits (ADR 0025 section 1).`,
    detail,
  );

/** `realpath` of `p`, or an `identity_unverifiable` naming what pointed at it. */
function realOrRefuse(dir: string, p: string, what: string): string {
  try {
    return realpathSync(p);
  } catch {
    throw unverifiable(
      dir,
      'broken_git_link',
      `${what} points to ${p}, which does not exist`,
    );
  }
}

/**
 * The git directory of the checkout at `dir`: the realpath of the nearest `.git`, a directory or a worktree's
 * `gitdir:` file (its first line, as git reads it).
 */
function gitDirOf(dir: string): string | undefined {
  for (let d = realpathSync(dir); ; d = dirname(d)) {
    const dotGit = join(d, '.git');
    let isFile = false;
    try {
      const st = lstatSync(dotGit);
      if (st.isSymbolicLink() || st.isDirectory())
        return realOrRefuse(dir, dotGit, '.git');
      isFile = st.isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      const first = readFileSync(dotGit, 'utf8').split('\n')[0] ?? '';
      const target = /^gitdir: (.+)$/.exec(first)?.[1]?.trim();
      if (target === undefined)
        throw unverifiable(
          dir,
          'broken_git_link',
          `${dotGit} is not a gitdir file`,
        );
      return realOrRefuse(
        dir,
        isAbsolute(target) ? target : resolve(d, target),
        dotGit,
      );
    }
    if (dirname(d) === d) return undefined;
  }
}

/** The shared git directory of a worktree (`commondir`), or the git directory itself. */
function commonDirOf(dir: string, gitDir: string): string {
  const file = join(gitDir, 'commondir');
  if (!existsSync(file)) return gitDir;
  const rel = readFileSync(file, 'utf8').trim();
  return realOrRefuse(dir, isAbsolute(rel) ? rel : resolve(gitDir, rel), file);
}

/**
 * The repository identity of the checkout at `dir` (ADR 0025 section 1): the sorted set of root commit hashes,
 * from `git rev-list --max-parents=0 --all`.
 *
 * @remarks git runs with a scrubbed environment (the fixed hook `PATH`, `HOME` from the passwd entry,
 *   `GIT_NO_REPLACE_OBJECTS=1`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_NO_LAZY_FETCH=1`), with `-c protocol.allow=never`,
 *   and with `--git-dir` set to the realpath of the discovered `.git`, so no `GIT_*` variable of the parent
 *   changes the answer and repository config cannot make git fetch (a promisor remote's `core.sshCommand` would
 *   otherwise run). Shallow, grafted and alternate-object repositories are refused from their files before git
 *   runs. The remote URL is never used. The identity is a copy detector, not authentication: any clone shares it,
 *   and a `.git` file at the registered root may point at the trusted repository's git directory.
 * @throws {TrustError} `identity_unverifiable` with a detail: `not_a_repository`, `broken_git_link`, `alternates`,
 *   `grafts`, `shallow`, `replace_refs`, `no_commit` or `git_failed`.
 */
export function projectIdentity(dir: string): string[] {
  const gitDir = gitDirOf(dir);
  if (gitDir === undefined)
    throw unverifiable(
      dir,
      'not_a_repository',
      'not a git repository; run git init and commit once, then try again',
    );
  const common = commonDirOf(dir, gitDir);
  if (existsSync(join(common, 'objects', 'info', 'alternates')))
    throw unverifiable(
      dir,
      'alternates',
      'alternates (objects/info/alternates) are set',
    );
  if (existsSync(join(common, 'info', 'grafts')))
    throw unverifiable(dir, 'grafts', 'grafts (.git/info/grafts) are set');
  if (existsSync(join(common, 'shallow')))
    throw unverifiable(dir, 'shallow', 'shallow clone; fetch the full history');
  const git = (args: string[]): string =>
    execFileSync(
      'git',
      ['-c', 'protocol.allow=never', `--git-dir=${gitDir}`, ...args],
      {
        env: {
          PATH: HOOK_PATH.join(':'),
          HOME: userInfo().homedir,
          GIT_NO_REPLACE_OBJECTS: '1',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_NO_LAZY_FETCH: '1',
        },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: GIT_TIMEOUT_MS,
      },
    );
  let replaced: string;
  let roots: string[];
  try {
    replaced = git(['for-each-ref', '--count=1', 'refs/replace/']).trim();
    roots =
      replaced === ''
        ? git(['rev-list', '--max-parents=0', '--all'])
            .split('\n')
            .filter((l) => /^[0-9a-f]{40,64}$/.test(l))
        : [];
  } catch {
    throw unverifiable(
      dir,
      'git_failed',
      `git could not read the history (git missing from ${HOOK_PATH.join(':')}, a timeout, a safe.directory refusal or missing objects); run git -C ${dir} log -1 to see why`,
    );
  }
  if (replaced !== '')
    throw unverifiable(
      dir,
      'replace_refs',
      'replace refs exist under refs/replace/',
    );
  if (roots.length === 0)
    throw unverifiable(dir, 'no_commit', 'no commit yet; commit once');
  return [...new Set(roots)].sort();
}

/**
 * True when a recorded identity matches the checkout's current one: the recorded set is non-empty and a subset
 * of the current set (a merge that adds a root keeps trust; another history shares no root).
 */
export const identityMatches = (recorded: string[], current: string[]) =>
  recorded.length > 0 && recorded.every((r) => current.includes(r));
