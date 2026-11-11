import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fixtureConfig } from './helpers.js';
import {
  TrustError,
  TrustStore,
  addProject,
  identityMatches,
  planProject,
  projectFor,
  projectIdentity,
  requireTrust,
} from '../src/trust/index.js';
import {
  git,
  gitInit,
  editStore,
  gitRepo,
  testOwnerKey,
  testStore,
} from './trust-fixture.js';

const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return `${e.kind}:${e.detail ?? ''}`;
    throw e;
  }
  return undefined;
};

const repo = (): { dir: string; root: string } => {
  const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'repo');
  mkdirSync(dir);
  const root = gitRepo(dir);
  writeFileSync(join(dir, 'a.txt'), 'a');
  git(dir, ['add', 'a.txt']);
  git(dir, ['commit', '-q', '-m', 'second']);
  return { dir, root };
};

describe('project identity (ADR 0025 section 1)', () => {
  it('is the sorted root-commit set, the same for a clone with another remote', () => {
    const { dir, root } = repo();
    expect(projectIdentity(dir)).toEqual([root]);
    const clone = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'clone');
    git(dir, ['clone', '-q', dir, clone]);
    git(clone, [
      'remote',
      'set-url',
      'origin',
      'https://example.invalid/x.git',
    ]);
    expect(projectIdentity(clone)).toEqual([root]);
    expect(identityMatches([root], projectIdentity(clone))).toBe(true);
    expect(identityMatches([], [root])).toBe(false);
  });

  it('ignores GIT_* variables of the parent, which would otherwise change the root set', () => {
    const a = repo();
    const graft = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'grafts');
    writeFileSync(graft, `${git(a.dir, ['rev-parse', 'HEAD'])}\n`);
    const saved = { ...process.env };
    try {
      process.env.GIT_GRAFT_FILE = graft;
      process.env.GIT_CONFIG_COUNT = '1';
      process.env.GIT_CONFIG_KEY_0 = 'core.alternateRefsCommand';
      process.env.GIT_CONFIG_VALUE_0 = 'false';
      process.env.GIT_DIR = join(repo().dir, '.git');
      expect(projectIdentity(a.dir)).toEqual([a.root]);
    } finally {
      process.env = saved;
    }
  });

  it('never lets repository config fetch: a promisor remote with core.sshCommand runs nothing', () => {
    const { dir } = repo();
    const marker = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'PWNED');
    git(dir, ['config', 'extensions.partialClone', 'origin']);
    git(dir, ['config', 'remote.origin.promisor', 'true']);
    git(dir, ['config', 'remote.origin.url', 'ssh://example.invalid/x.git']);
    git(dir, ['config', 'core.sshCommand', `touch ${marker}`]);
    writeFileSync(
      join(dir, '.git', 'refs', 'heads', 'missing'),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\n',
    );
    expect(kindOf(() => projectIdentity(dir))).toBe(
      'identity_unverifiable:git_failed',
    );
    expect(existsSync(marker)).toBe(false);
  });

  it('follows a worktree .git file and its commondir, and refuses a broken one with a typed error', () => {
    const { dir, root } = repo();
    const wt = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'wt');
    git(dir, ['worktree', 'add', '-q', '--detach', wt]);
    expect(projectIdentity(wt)).toEqual([root]);
    const broken = mkdtempSync(join(tmpdir(), 'flowctl-id-'));
    writeFileSync(join(broken, '.git'), 'gitdir: /nonexistent/flowctl/x\n');
    expect(kindOf(() => projectIdentity(broken))).toBe(
      'identity_unverifiable:broken_git_link',
    );
  });

  it('refuses a shallow clone, grafts, replace refs, alternates, no commit and no repository', () => {
    const { dir } = repo();
    const shallow = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'shallow');
    git(dir, ['clone', '-q', '--depth', '1', `file://${dir}`, shallow]);
    expect(kindOf(() => projectIdentity(shallow))).toBe(
      'identity_unverifiable:shallow',
    );

    const grafted = repo();
    writeFileSync(
      join(grafted.dir, '.git', 'info', 'grafts'),
      `${grafted.root}\n`,
    );
    expect(kindOf(() => projectIdentity(grafted.dir))).toBe(
      'identity_unverifiable:grafts',
    );

    const replaced = repo();
    const head = git(replaced.dir, ['rev-parse', 'HEAD']);
    git(replaced.dir, ['replace', head, replaced.root]);
    expect(kindOf(() => projectIdentity(replaced.dir))).toBe(
      'identity_unverifiable:replace_refs',
    );

    const alt = repo();
    writeFileSync(
      join(alt.dir, '.git', 'objects', 'info', 'alternates'),
      join(dir, '.git', 'objects'),
    );
    expect(kindOf(() => projectIdentity(alt.dir))).toBe(
      'identity_unverifiable:alternates',
    );

    const empty = join(mkdtempSync(join(tmpdir(), 'flowctl-id-')), 'empty');
    mkdirSync(empty);
    gitInit(empty);
    expect(kindOf(() => projectIdentity(empty))).toBe(
      'identity_unverifiable:no_commit',
    );

    const plain = mkdtempSync(join(tmpdir(), 'flowctl-id-'));
    expect(kindOf(() => projectIdentity(plain))).toBe(
      'identity_unverifiable:not_a_repository',
    );
  });

  it('refuses a registered root whose history was replaced by another repository', () => {
    const cfg = fixtureConfig('http://127.0.0.1:1');
    mkdirSync(cfg.flowsPath, { recursive: true });
    const store = testStore(cfg);
    expect(projectFor(store, cfg.root)).toBe('test-project');
    rmSync(join(cfg.root, '.git'), { recursive: true, force: true });
    gitInit(cfg.root);
    git(cfg.root, ['commit', '-q', '--allow-empty', '-m', 'another history']);
    expect(kindOf(() => projectFor(store, cfg.root))).toBe(
      'project_not_trusted:identity_mismatch',
    );
  });

  it('refuses an entry that predates identity and says how to record it', () => {
    const cfg = fixtureConfig('http://127.0.0.1:1');
    mkdirSync(cfg.flowsPath, { recursive: true });
    const store = testStore(cfg);
    const current = store.data.projects['test-project'];
    if (current === undefined) throw new Error('no project');
    const { sig: _old, ...entry } = current;
    const value = { ...entry, identity: [] };
    editStore(store.dir, (d) => ({
      ...d,
      projects: {
        'test-project': {
          ...value,
          sig: testOwnerKey().signEntry({
            id: 'test-project',
            kind: 'projects',
            value,
          }),
        },
      },
    }));
    let err: unknown;
    try {
      projectFor(TrustStore.open(store.dir), cfg.root);
    } catch (e) {
      err = e;
    }
    expect(err).toMatchObject({
      kind: 'project_not_trusted',
      detail: 'no_identity',
    });
    expect(err instanceof Error ? err.message : '').toContain(
      'flowctl trust add project',
    );
  });
});

describe('trust add project (ADR 0025 section 3)', () => {
  const second = () => {
    const root = join(mkdtempSync(join(tmpdir(), 'flowctl-p2-')), 'repo');
    const flows = join(root, '.flows');
    mkdirSync(flows, { recursive: true });
    gitRepo(root);
    return { root, flows };
  };

  it('registers a second project with its identity and flows root', () => {
    const cfg = fixtureConfig('http://127.0.0.1:1');
    mkdirSync(cfg.flowsPath, { recursive: true });
    const store = testStore(cfg);
    const p = second();
    const plan = planProject(store, {
      name: 'second',
      projectDir: p.root,
      flowsDir: p.flows,
    });
    expect(plan.identity).toEqual(projectIdentity(p.root));
    addProject(store, testOwnerKey(), plan);
    const after = TrustStore.open(store.dir);
    expect(
      requireTrust(after, { projectDir: p.root, flowsDir: p.flows }).project,
    ).toBe('second');
    expect(
      requireTrust(after, { projectDir: cfg.root, flowsDir: cfg.flowsPath })
        .project,
    ).toBe('test-project');
  });

  it('refuses a name or a root that is already registered, and a bad name', () => {
    const cfg = fixtureConfig('http://127.0.0.1:1');
    mkdirSync(cfg.flowsPath, { recursive: true });
    const store = testStore(cfg);
    const p = second();
    for (const t of [
      { name: 'test-project', projectDir: p.root, flowsDir: p.flows },
      { name: 'other', projectDir: cfg.root, flowsDir: cfg.flowsPath },
      { name: 'Bad Name', projectDir: p.root, flowsDir: p.flows },
    ])
      expect(kindOf(() => planProject(store, t))).toBe('trust_entry_invalid:');
  });

  it('records the identity of an entry that predates it, keeping its defaults', () => {
    const cfg = fixtureConfig('http://127.0.0.1:1');
    mkdirSync(cfg.flowsPath, { recursive: true });
    const store = testStore(cfg);
    const current = store.data.projects['test-project'];
    if (current === undefined) throw new Error('no project');
    const { sig: _old, ...entry } = current;
    const value = { ...entry, identity: [] };
    editStore(store.dir, (d) => ({
      ...d,
      projects: {
        'test-project': {
          ...value,
          sig: testOwnerKey().signEntry({
            id: 'test-project',
            kind: 'projects',
            value,
          }),
        },
      },
    }));
    const old = TrustStore.open(store.dir);
    const plan = planProject(old, {
      name: 'test-project',
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
    });
    expect(plan.upgrade).toBe(true);
    addProject(old, testOwnerKey(), plan);
    const after = TrustStore.open(store.dir);
    expect(projectFor(after, cfg.root)).toBe('test-project');
    expect(after.data.projects['test-project']?.defaultEnv).toBe(
      entry.defaultEnv,
    );
  });
});
