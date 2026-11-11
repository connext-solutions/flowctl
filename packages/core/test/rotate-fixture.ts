import { existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureConfig } from './helpers.js';
import {
  createOwnerKey,
  initTrust,
  type OwnerKey,
  type ReplaceInit,
  TrustError,
} from '../src/trust/index.js';
import { gitRepo, localAnswers, testAnchorDir } from './trust-fixture.js';

/** The passphrase of a {@link fresh} store's first key. */
export const OLD = 'correct horse battery staple';
/** The passphrase a rotation gives the new key. */
export const NEW = 'a different and long passphrase';
/** Each rotation runs scrypt twice (about a second each). */
export const SLOW = 60_000;

/** `kind:detail` of the TrustError `f` throws, or `undefined`. */
export const kindOf = (f: () => unknown): string | undefined => {
  try {
    f();
  } catch (e) {
    if (e instanceof TrustError) return `${e.kind}:${e.detail ?? ''}`;
    throw e;
  }
  return undefined;
};

/**
 * A store pinned to its own owner key, so a rotation never touches the shared test key, and the `trust init` inputs
 * a replacement of it takes (with a test anchor directory, so no test writes the real keychain).
 */
export function fresh(): {
  storeDir: string;
  keyDir: string;
  key: OwnerKey;
  init: ReplaceInit;
} {
  const cfg = fixtureConfig('http://127.0.0.1:1');
  mkdirSync(cfg.flowsPath, { recursive: true });
  gitRepo(cfg.root);
  const base = mkdtempSync(join(tmpdir(), 'flowctl-rotate-'));
  const keyDir = join(base, 'keys');
  const storeDir = join(base, 'store');
  const key = createOwnerKey(keyDir, OLD);
  const init: ReplaceInit = {
    project: 'test-project',
    projectDir: cfg.root,
    flowsDir: cfg.flowsPath,
    answers: localAnswers(cfg),
    anchorDir: testAnchorDir(),
  };
  initTrust({ ...init, storeDir, key });
  return {
    storeDir,
    keyDir,
    key,
    init: { ...init, anchorDir: testAnchorDir() },
  };
}

/** The retired owner-key files in `keyDir`, sorted. */
export const retired = (keyDir: string): string[] =>
  readdirSync(keyDir)
    .filter((f) => f.startsWith('owner.key.retired-'))
    .sort();

/** Whether any file a rotation stages is left. */
export const staged = (storeDir: string, keyDir: string): boolean =>
  ['trust.json.new', 'trust.log.new'].some((f) =>
    existsSync(join(storeDir, f)),
  ) || existsSync(join(keyDir, 'owner.key.new'));
