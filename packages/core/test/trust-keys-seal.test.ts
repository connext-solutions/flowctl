import { generateKeyPairSync } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  assertReviewerPassphrase,
  createOwnerKey,
  createReviewerKeyFile,
  loadOwnerKey,
  loadReviewerKey,
  parsePublicKey,
} from '../src/trust/index.js';
import { verifyMessage } from '../src/trust/signing.js';
import { kindOf } from './rotate-fixture.js';

const PASS = 'a long enough reviewer passphrase';
const mode = (f: string): number => statSync(f).mode & 0o777;
let shared:
  | { dir: string; keyFile: string; pubFile: string; publicKey: Buffer }
  | undefined;

/** One sealed reviewer key per test process: scrypt at N = 2^17 costs about a second. */
function sealed() {
  if (shared === undefined) {
    const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-revkey-')), 'keys');
    const made = createReviewerKeyFile(join(dir, 'alice.key'), PASS);
    shared = { dir, ...made };
  }
  return shared;
}

describe('reviewer key file (T1.15)', () => {
  it('needs 16 code points after NFKC and writes nothing otherwise', () => {
    expect(() => assertReviewerPassphrase('ﬁ'.repeat(8))).not.toThrow();
    expect(kindOf(() => assertReviewerPassphrase(`${'ﬁ'.repeat(7)}x`))).toBe(
      'passphrase_too_short:',
    );
    const dir = join(mkdtempSync(join(tmpdir(), 'flowctl-revkey-')), 'none');
    expect(
      kindOf(() => createReviewerKeyFile(join(dir, 'a.key'), 'short')),
    ).toBe('passphrase_too_short:');
    expect(existsSync(dir)).toBe(false);
  });

  it('writes a 0400 encrypted key file in a 0700 directory and a public .pub, never overwriting', () => {
    const k = sealed();
    expect(mode(k.keyFile)).toBe(0o400);
    expect(mode(k.dir)).toBe(0o700);
    expect(mode(k.pubFile)).toBe(0o644);
    const text = readFileSync(k.keyFile, 'utf8');
    expect(Object.keys(JSON.parse(text)).sort()).toEqual(
      ['N', 'ct', 'kdf', 'nonce', 'p', 'r', 'salt', 'v'].sort(),
    );
    expect(text).not.toContain('PRIVATE');
    expect(
      parsePublicKey(readFileSync(k.pubFile, 'utf8')).equals(k.publicKey),
    ).toBe(true);
    expect(kindOf(() => createReviewerKeyFile(k.keyFile, PASS))).toBe(
      'key_exists:',
    );
    expect(
      kindOf(() => createReviewerKeyFile(join(k.dir, 'alice.pub'), PASS)),
    ).toBe('key_exists:');
  });

  it('unlocks with the passphrase and signs what its public key verifies', () => {
    const k = sealed();
    const signer = loadReviewerKey(k.keyFile, PASS);
    expect(signer.publicKey.equals(k.publicKey)).toBe(true);
    const message = Buffer.from('approve flow x');
    expect(verifyMessage(signer.publicKey, message, signer.sign(message))).toBe(
      true,
    );
    expect(kindOf(() => loadReviewerKey(k.keyFile, `${PASS}!`))).toBe(
      'key_unlock_failed:',
    );
  });

  it('refuses weak parameters, loose modes, a missing file and an owner key file', () => {
    const k = sealed();
    const doc = JSON.parse(readFileSync(k.keyFile, 'utf8'));
    const weak = join(k.dir, 'weak.key');
    writeFileSync(weak, JSON.stringify({ ...doc, N: 1024 }), { mode: 0o400 });
    expect(kindOf(() => loadReviewerKey(weak, PASS))).toBe('key_params_weak:');
    const odd = join(k.dir, 'odd.key');
    writeFileSync(odd, JSON.stringify({ ...doc, N: 131_073 }), { mode: 0o400 });
    expect(kindOf(() => loadReviewerKey(odd, PASS))).toBe(
      'key_params_unsupported:',
    );
    const loose = join(k.dir, 'loose.key');
    copyFileSync(k.keyFile, loose);
    chmodSync(loose, 0o644);
    expect(kindOf(() => loadReviewerKey(loose, PASS))).toBe(
      'trust_tampered:key_file',
    );
    expect(kindOf(() => loadReviewerKey(join(k.dir, 'none.key'), PASS))).toBe(
      'key_missing:',
    );
    const ownerDir = join(
      mkdtempSync(join(tmpdir(), 'flowctl-ownerkey-')),
      'o',
    );
    createOwnerKey(ownerDir, PASS);
    const asReviewer = join(k.dir, 'owner-as-reviewer.key');
    copyFileSync(join(ownerDir, 'owner.key'), asReviewer);
    expect(kindOf(() => loadReviewerKey(asReviewer, PASS))).toBe(
      'key_unlock_failed:',
    );
    const keyDir = join(mkdtempSync(join(tmpdir(), 'flowctl-ownerkey-')), 'o');
    createOwnerKey(keyDir, PASS);
    copyFileSync(k.keyFile, join(keyDir, 'owner.key.new'));
    chmodSync(join(keyDir, 'owner.key.new'), 0o400);
    expect(kindOf(() => loadOwnerKey(keyDir, PASS, 'owner.key.new'))).toBe(
      'key_unlock_failed:',
    );
  });
});

const spki = (): { pem: string; raw: Buffer } => {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  return {
    pem: publicKey.export({ format: 'pem', type: 'spki' }).toString(),
    raw: Buffer.from(der.subarray(der.length - 32)),
  };
};

const sshLine = (raw: Buffer, comment = 'alice@laptop'): string => {
  const name = Buffer.from('ssh-ed25519');
  const len = (n: number) => Buffer.from([0, 0, 0, n]);
  const blob = Buffer.concat([len(name.length), name, len(32), raw]);
  return `ssh-ed25519 ${blob.toString('base64')} ${comment}\n`;
};

describe('public key files (T1.15)', () => {
  it('reads a PEM public key and an OpenSSH ssh-ed25519 line', () => {
    const { pem, raw } = spki();
    expect(parsePublicKey(pem).equals(raw)).toBe(true);
    expect(parsePublicKey(sshLine(raw)).equals(raw)).toBe(true);
    expect(parsePublicKey(sshLine(raw, '')).equals(raw)).toBe(true);
  });

  it('refuses private key material before parsing it, with no key text in the message', () => {
    const priv = generateKeyPairSync('ed25519')
      .privateKey.export({ format: 'pem', type: 'pkcs8' })
      .toString();
    for (const text of [
      priv,
      '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----\n',
    ]) {
      let err: unknown;
      try {
        parsePublicKey(text);
      } catch (e) {
        err = e;
      }
      expect(err).toMatchObject({
        kind: 'trust_entry_invalid',
        detail: 'private_key_given',
      });
      expect(String((err as Error).message)).not.toContain('AAAA');
    }
  });

  it('refuses a bare base64 string, another key type, a bad blob and oversized text', () => {
    const { raw } = spki();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
      .publicKey.export({ format: 'pem', type: 'spki' })
      .toString();
    for (const text of [
      raw.toString('base64'),
      rsa,
      'ssh-ed25519 AAAA x',
      'ssh-rsa AAAAB3Nza x',
      '',
      'a'.repeat(5000),
    ])
      expect(kindOf(() => parsePublicKey(text))).toBe(
        'trust_entry_invalid:public_key_invalid',
      );
  });
});
