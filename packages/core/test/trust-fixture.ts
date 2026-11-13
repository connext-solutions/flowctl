import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LoadedConfig } from '../src/config.js';
import {
  addProfileEnvVar,
  createOwnerKey,
  type InitAnswers,
  initTrust,
  type OwnerKey,
  planHookConsent,
  saveHookConsents,
  TrustStore,
} from '../src/trust/index.js';
import { chooseAnchor, writeAnchor } from '../src/trust/anchor.js';
import {
  genesisLine,
  lineHash,
  lineText,
  newStoreId,
  writeLine,
} from '../src/trust/log.js';
import { TrustStoreSchema, type TrustStoreDoc } from '../src/trust/schema.js';

const PASS = 'correct horse battery staple';
let cachedKey: { dir: string; key: OwnerKey } | undefined;

/** One owner key per test process; scrypt at N = 2^17 costs about a second, so it is made once. */
function ownerKey(): OwnerKey {
  cachedKey ??= (() => {
    const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-testkey-')), 'keys');
    return { dir, key: createOwnerKey(dir, PASS) };
  })();
  return cachedKey.key;
}

/**
 * A trust store for one test project, opened through the internal `TrustStore.open(dir)` seam (ADR 0025
 * section 1), with the project and its flows directory registered and owner-signed, and every env of
 * the config classed `local` (the answers an owner of a local test app would type at `trust init`).
 */
export function testStore(cfg: LoadedConfig): TrustStore {
  const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-store-')), 'store');
  gitRepo(cfg.root);
  initTrust({
    storeDir: dir,
    key: ownerKey(),
    project: 'test-project',
    projectDir: cfg.root,
    flowsDir: cfg.flowsPath,
    answers: localAnswers(cfg),
    anchorDir: testAnchorDir(),
  });
  return TrustStore.open(dir);
}

/** A fresh directory for a test store's anchor file, so tests never write the real keychain. */
export const testAnchorDir = (): string =>
  join(mkdtempSync(join(tmpdir(), 'flowctl-anchor-')), 'anchors');

/**
 * Writes `doc` as a complete store in `dir`: `trust.json` with its head and owner-signed anchor entry, a `trust.log`
 * whose genesis is signed by the test owner key, and a file anchor. A document the store schema refuses is written
 * as it is, so a test can reach the schema check. Unit tests use it for stores they build by hand.
 *
 * @param key signs the genesis line and the anchor entry; it must be the key `doc` pins, or the store reads as
 *   tampered.
 */
export function rawStore(
  dir: string,
  doc: Record<string, unknown>,
  key: OwnerKey = ownerKey(),
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const storeId = newStoreId();
  const location = chooseAnchor(storeId, dir, testAnchorDir());
  const withAnchor = {
    ...doc,
    anchor: {
      ...location,
      sig: key.signEntry({ id: 'anchor', kind: 'anchor', value: location }),
    },
  };
  const parsed = TrustStoreSchema.safeParse(withAnchor);
  if (!parsed.success) {
    writeFileSync(join(dir, 'trust.json'), JSON.stringify(doc), {
      mode: 0o600,
    });
    return;
  }
  const genesis = genesisLine(key, storeId, location);
  const first = writeLine(genesis, parsed.data);
  writeAnchor(location, {
    v: 1,
    storeId,
    ownerFingerprint: key.fingerprint,
    head: lineHash(first),
    seq: first.seq,
    pending: null,
  });
  writeFileSync(
    join(dir, 'trust.log'),
    `${lineText(genesis)}\n${lineText(first)}\n`,
    { mode: 0o600 },
  );
  writeFileSync(
    join(dir, 'trust.json'),
    JSON.stringify({ ...withAnchor, head: lineHash(first) }),
    { mode: 0o600 },
  );
}

/**
 * Consents to the hooks of each flow in `store` the way `flowctl trust hook` does, and returns the reopened
 * store.
 */
export function consentHooks(
  cfg: LoadedConfig,
  store: TrustStore,
  flows: { name: string; setup?: string; teardown?: string }[],
  choices: { env: string[]; pins: Record<string, string> } = {
    env: [],
    pins: {},
  },
): TrustStore {
  const plans = flows.map((f) => ({
    plan: planHookConsent(store, {
      projectDir: cfg.root,
      flowsDir: cfg.flowsPath,
      flow: f.name,
      setup: f.setup,
      teardown: f.teardown,
    }),
    env: choices.env,
    pins: choices.pins,
  }));
  saveHookConsents(store, ownerKey(), plans);
  return TrustStore.open(store.dir);
}

/** `trust init` answers that class every env of `cfg` as `local` and keep its default env. */
export function localAnswers(cfg: LoadedConfig): InitAnswers {
  const envs: InitAnswers['envs'] = {};
  for (const [name, e] of Object.entries(cfg.envs))
    envs[name] = { origin: new URL(e.baseUrl).origin, class: 'local' };
  return {
    envs,
    productionOrigins: [],
    defaultEnv: cfg.defaultEnv,
    language: 'vi',
    locale: 'vi-VN',
  };
}

/** The process-wide test owner key, for tests that sign entries themselves. */
export const testOwnerKey = (): OwnerKey => ownerKey();

/**
 * Rewrites `trust.json` with `edit`, appends a matching `write` line to `trust.log` and moves the anchor to it, the
 * way an editor of the same user who knows the format could (write lines are not signed; ADR 0025 section 6). Tests
 * use it to reach the entry-signature checks behind the log and anchor checks.
 */
export function editStore(
  dir: string,
  edit: (doc: TrustStoreDoc) => TrustStoreDoc,
): void {
  const store = TrustStore.open(dir);
  const last = store.log.at(-1);
  if (last === undefined) throw new Error('editStore needs a store with a log');
  const doc = edit(structuredClone(store.data));
  const line = writeLine(last, doc);
  appendFileSync(join(dir, 'trust.log'), `${lineText(line)}\n`);
  writeFileSync(
    join(dir, 'trust.json'),
    JSON.stringify({ ...doc, head: lineHash(line) }),
    { mode: 0o600 },
  );
  const anchor = store.anchor;
  if (anchor !== undefined)
    writeAnchor(anchor.location, {
      ...anchor.record,
      head: lineHash(line),
      seq: line.seq,
      pending: null,
    });
}

/**
 * Allows each variable of `names` for `profile` the way `flowctl trust add profile` does (kind `secret`), and
 * returns the reopened store.
 */
export function allowEnvVars(
  store: TrustStore,
  profile: string,
  names: string[],
): TrustStore {
  for (const name of names)
    addProfileEnvVar(store, ownerKey(), profile, { name, kind: 'secret' });
  return TrustStore.open(store.dir);
}

/**
 * Creates a git repository in `dir` with the `GIT_*` variables removed from the environment. Inside a git hook
 * (`pre-push` runs `verify`), git exports `GIT_DIR`, and a plain `git init <dir>` would re-initialise the
 * repository running the hook instead, setting its `core.bare` to true.
 */
export function gitInit(dir: string): void {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  );
  execFileSync('git', ['init', '-q', dir], { env });
}

/** The environment of a test git call: no `GIT_*` of a surrounding hook, and a fixed author. */
const gitEnv = (): NodeJS.ProcessEnv => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')),
  ),
  GIT_AUTHOR_NAME: 'flowctl test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'flowctl test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
});

/** Runs git in `dir` with {@link gitEnv} and returns its trimmed output. */
export const git = (dir: string, args: string[]): string =>
  execFileSync('git', ['-C', dir, ...args], {
    env: gitEnv(),
    encoding: 'utf8',
  }).trim();

/**
 * Makes `dir` a git repository with one empty commit unless it already is one, so `trust init` can record its
 * identity (ADR 0025 section 1).
 *
 * @returns the root commit hash.
 */
export function gitRepo(dir: string): string {
  if (!existsSync(join(dir, '.git'))) {
    gitInit(dir);
    git(dir, ['commit', '-q', '--allow-empty', '-m', 'root']);
  }
  return git(dir, ['rev-list', '--max-parents=0', 'HEAD']);
}

/** The store in `store.dir` read again, as a command does after another one changed it. */
export const reopenStore = (store: TrustStore): TrustStore =>
  TrustStore.open(store.dir);
