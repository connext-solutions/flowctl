import { generateKeyPairSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { addReviewerKey, loadConfig, type TrustStore } from '@flowctl/core';
import { reopenStore, testOwnerKey, testStore } from '@flowctl/core-testing';
import { runCli } from '../src/main.js';
import { USAGE } from '../src/usage.js';

/**
 * `trust key new|add|revoke` refusals that need no terminal, and the missing terminal itself (ADR 0025 section 3).
 * Everything checked here happens before the first prompt, so the tests run in the unit tier.
 */
let err: string[];
let file: string;
let store: TrustStore;
let root: string;
beforeEach(() => {
  err = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => {
    err.push(String(c));
    return true;
  });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  root = mkdtempSync(join(tmpdir(), 'flowctl-cli-key-'));
  mkdirSync(join(root, '.flows'));
  file = join(root, 'flowctl.config.yaml');
  writeFileSync(
    file,
    stringify({
      defaultEnv: 'local',
      envs: { local: { baseUrl: 'http://127.0.0.1:9' } },
      profiles: { manager: {} },
    }),
  );
  store = testStore(loadConfig(file));
});
afterEach(() => vi.restoreAllMocks());

const run = (argv: string[]): Promise<number> =>
  runCli([...argv, '--config', file], { openStore: () => store });
const outside = (): string => mkdtempSync(join(tmpdir(), 'flowctl-cli-out-'));
const NEW = [
  'trust',
  'key',
  'new',
  '--person',
  'Alice',
  '--scope',
  'flows',
  '--expires',
  '30',
];

const publicFile = (): string => {
  const pem = generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'pem', type: 'spki' })
    .toString();
  const path = join(outside(), 'alice.pub');
  writeFileSync(path, pem);
  return path;
};
const ADD = (path: string): string[] => [
  'trust',
  'key',
  'add',
  path,
  '--person',
  'Alice',
  '--scope',
  'spec',
  '--expires',
  '30',
  '--custody',
  'hardware',
];

describe('flowctl trust key new (T1.15)', () => {
  it.each([
    [['--person', 'Alice', '--scope', 'flows'], '--expires is required'],
    [['--scope', 'flows', '--expires', '30'], '--person is required'],
    [['--person', 'Alice', '--expires', '30'], '--scope is required'],
    [
      ['--person', 'Alice', '--scope', 'both', '--expires', '30'],
      'must be flows or spec',
    ],
    [
      ['--person', 'Alice', '--scope', 'flows', '--expires', '0'],
      'whole number of days',
    ],
    [
      ['--person', 'Alice', '--scope', 'flows', '--expires', '366'],
      'whole number of days',
    ],
    [
      ['--person', 'Al​ice', '--scope', 'flows', '--expires', '30'],
      'plain text',
    ],
  ])('refuses %j before any prompt', async (opts, says) => {
    expect(await run(['trust', 'key', 'new', ...opts])).toBe(3);
    expect(err.join('')).toContain(says);
    expect(err.join('')).not.toContain('tty_required');
  });

  it('refuses a key path inside a repository, the store or a symlink to either, before any prompt', async () => {
    expect(await run([...NEW, '--out', join(root, 'a.key')])).toBe(3);
    expect(err.join('')).toContain('inside a git repository');
    err.length = 0;
    expect(await run([...NEW, '--out', join(store.dir, 'deep', 'a.key')])).toBe(
      3,
    );
    expect(err.join('')).toContain('owner key or the trust store');
    expect(err.join('')).not.toContain('tty_required');
  });

  it('exits 3 with tty_required when everything else is fine, and exits 2 on the wrong arity', async () => {
    expect(await run([...NEW, '--out', join(outside(), 'a.key')])).toBe(3);
    expect(err.join('')).toContain('tty_required');
    err.length = 0;
    expect(await run([...NEW, 'extra'])).toBe(2);
    expect(err.join('')).toContain('Usage');
  });
});

describe('flowctl trust key add (T1.15)', () => {
  it('refuses a missing option, a missing file, private key material and a bad key before any prompt', async () => {
    const good = publicFile();
    expect(await run(ADD(good).slice(0, -2))).toBe(3);
    expect(err.join('')).toContain('--custody is required');
    err.length = 0;
    expect(await run([...ADD(good).slice(0, -1), 'software'])).toBe(3);
    expect(err.join('')).toContain('must be file or hardware');
    err.length = 0;
    expect(await run(ADD(join(outside(), 'none.pub')))).toBe(3);
    expect(err.join('')).toContain('Cannot read the public key file');
    const priv = join(outside(), 'id.pem');
    writeFileSync(
      priv,
      generateKeyPairSync('ed25519').privateKey.export({
        format: 'pem',
        type: 'pkcs8',
      }),
    );
    err.length = 0;
    expect(await run(ADD(priv))).toBe(3);
    expect(err.join('')).toContain('private key material');
    const junk = join(outside(), 'junk.pub');
    writeFileSync(junk, 'not a key');
    err.length = 0;
    expect(await run(ADD(junk))).toBe(3);
    expect(err.join('')).toContain('not an Ed25519 public key');
    expect(err.join('')).not.toContain('tty_required');
  });

  it('exits 3 with tty_required for a valid public key, and 2 without a file argument', async () => {
    expect(await run(ADD(publicFile()))).toBe(3);
    expect(err.join('')).toContain('tty_required');
    err.length = 0;
    expect(await run(['trust', 'key', 'add'])).toBe(2);
    expect(err.join('')).toContain('Usage');
  });
});

describe('flowctl trust key revoke (T1.15)', () => {
  it('refuses an unknown or revoked key and a bad reason before any prompt, then needs a terminal', async () => {
    const der = generateKeyPairSync('ed25519').publicKey.export({
      format: 'der',
      type: 'spki',
    });
    const added = addReviewerKey(
      store,
      testOwnerKey(),
      Buffer.from(der.subarray(der.length - 32)),
      { person: 'Alice', scope: 'flows', days: 30 },
      'file',
    );
    store = reopenStore(store);
    expect(await run(['trust', 'key', 'revoke', 'f'.repeat(64)])).toBe(3);
    expect(err.join('')).toContain('no reviewer key');
    err.length = 0;
    expect(
      await run([
        'trust',
        'key',
        'revoke',
        added.id,
        '--reason',
        'bad\nreason',
      ]),
    ).toBe(3);
    expect(err.join('')).toContain('--reason');
    err.length = 0;
    expect(
      await run([
        'trust',
        'key',
        'revoke',
        added.id,
        '--reason',
        'laptop lost',
      ]),
    ).toBe(3);
    expect(err.join('')).toContain('tty_required');
    err.length = 0;
    expect(await run(['trust', 'key', 'revoke'])).toBe(2);
    expect(err.join('')).toContain('Usage');
  });

  it('is listed in the usage text with its two siblings', () => {
    for (const name of ['trust key new', 'trust key add', 'trust key revoke'])
      expect(USAGE).toContain(`flowctl ${name}`);
    expect(dirname(file)).toBe(root);
  });
});
