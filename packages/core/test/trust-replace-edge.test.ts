import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addProfileEnvVar,
  loadOwnerKey,
  planReplace,
  replaceStore,
  replaceStoreUntil,
  stagedStoreDir,
  TrustStore,
  trustedProfile,
} from '../src/trust/index.js';
import { ANCHOR_BINARIES } from '../src/trust/anchor.js';
import { verifyLog } from '../src/trust/log-read.js';
import { lineText, writeLine } from '../src/trust/log.js';
import { fresh, kindOf, NEW, OLD, SLOW } from './rotate-fixture.js';
import { testAnchorDir } from './trust-fixture.js';

const saved = { ...ANCHOR_BINARIES };
afterEach(() => Object.assign(ANCHOR_BINARIES, saved));

describe('trust init --replace edges (ADR 0025 Amendment 2026-11-02 section 6)', () => {
  it(
    'a failure in step 2 leaves the old store and key usable and sets the new key aside',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key, init } = fresh();
      ANCHOR_BINARIES.security = '/nonexistent/security';
      ANCHOR_BINARIES.secretTool = '/nonexistent/secret-tool';
      expect(
        kindOf(() =>
          replaceStore(storeDir, keyDir, planReplace(storeDir), key, NEW, {
            ...init,
            anchorDir: undefined,
          }),
        ),
      ).toBe('anchor_unavailable:');
      expect(existsSync(stagedStoreDir(storeDir))).toBe(false);
      expect(existsSync(join(keyDir, 'owner.key.new'))).toBe(false);
      expect(
        readdirSync(keyDir).filter((f) => f.startsWith('owner.key.abandoned-')),
      ).toHaveLength(1);
      expect(loadOwnerKey(keyDir, OLD).fingerprint).toBe(key.fingerprint);
      expect(TrustStore.open(storeDir).data.ownerFingerprint).toBe(
        key.fingerprint,
      );
    },
  );

  it(
    'cutting the replaced line off the old log does not revive the old store',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key, init } = fresh();
      expect(() =>
        replaceStoreUntil(
          storeDir,
          keyDir,
          planReplace(storeDir),
          key,
          NEW,
          init,
          'marked',
        ),
      ).toThrow('simulated crash');
      const file = join(storeDir, 'trust.log');
      const rows = readFileSync(file, 'utf8').split('\n');
      writeFileSync(file, `${rows.slice(0, -2).join('\n')}\n`, { mode: 0o600 });
      expect(kindOf(() => TrustStore.open(storeDir))).toBe(
        'trust_tampered:anchor_head_mismatch',
      );
    },
  );

  it(
    'drops old entries, keeps two replacements of one day apart, and refuses a line after replaced',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key, init } = fresh();
      addProfileEnvVar(TrustStore.open(storeDir), key, 'employee', {
        name: 'QA_PASSWORD',
        kind: 'secret',
      });
      const first = replaceStore(
        storeDir,
        keyDir,
        planReplace(storeDir),
        key,
        NEW,
        init,
      );
      expect(trustedProfile(TrustStore.open(storeDir), 'employee')).toBe(
        undefined,
      );
      const second = replaceStore(
        storeDir,
        keyDir,
        planReplace(storeDir),
        loadOwnerKey(keyDir, NEW),
        OLD,
        { ...init, anchorDir: testAnchorDir() },
      );
      expect(first.replacedDir).toMatch(/\.1$/);
      expect(second.replacedDir).toMatch(/\.2$/);
      const oldLog = join(first.replacedDir, 'trust.log');
      const owner = { publicKey: key.publicKey, fingerprint: key.fingerprint };
      const lines = verifyLog(readFileSync(oldLog, 'utf8'), owner);
      const last = lines.at(-1);
      if (last === undefined) throw new Error('empty log');
      appendFileSync(
        oldLog,
        `${lineText(writeLine(last, TrustStore.open(storeDir).data))}\n`,
      );
      expect(kindOf(() => verifyLog(readFileSync(oldLog, 'utf8'), owner))).toBe(
        'trust_tampered:log_chain',
      );
    },
  );
});
