import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  abandonReplace,
  addProfileEnvVar,
  loadOwnerKey,
  planReplace,
  recoverRotation,
  replaceStore,
  replaceStoreUntil,
  requireTrust,
  stagedStoreDir,
  TrustStore,
} from '../src/trust/index.js';
import { verifyLog } from '../src/trust/log-read.js';
import { fresh, kindOf, NEW, OLD, retired, SLOW } from './rotate-fixture.js';

const replacedDirs = (storeDir: string): string[] =>
  readdirSync(dirname(storeDir))
    .filter((n) => n.startsWith(`${basename(storeDir)}.replaced-`))
    .map((n) => join(dirname(storeDir), n));

describe('trust init --replace (ADR 0025 Amendment 2026-11-02 section 6)', () => {
  it(
    'makes a new store that carries nothing over and ends the old log with replaced',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key, init } = fresh();
      const old = TrustStore.open(storeDir);
      addProfileEnvVar(old, key, 'employee', {
        name: 'QA_PASSWORD',
        kind: 'secret',
      });
      const before = TrustStore.open(storeDir);
      const oldAnchor = before.anchor.location.locator;
      const plan = planReplace(storeDir);
      const done = replaceStore(storeDir, keyDir, plan, key, NEW, init);
      const store = TrustStore.open(storeDir);
      expect(store.data.ownerFingerprint).toBe(done.fingerprint);
      expect(store.data.profiles).toEqual({});
      const genesis = store.log[0];
      expect(genesis?.kind === 'genesis' && genesis.body.replaces).toEqual({
        fingerprint: key.fingerprint,
        head: before.data.head,
      });
      expect(
        requireTrust(store, {
          projectDir: init.projectDir,
          flowsDir: init.flowsDir,
        }).project,
      ).toBe('test-project');
      expect(replacedDirs(storeDir)).toEqual([done.replacedDir]);
      expect(kindOf(() => TrustStore.open(done.replacedDir))).toBe(
        'store_replaced:',
      );
      const oldLog = verifyLog(
        readFileSync(join(done.replacedDir, 'trust.log'), 'utf8'),
        { publicKey: key.publicKey, fingerprint: key.fingerprint },
      );
      expect(oldLog.at(-1)).toMatchObject({
        kind: 'replaced',
        body: { newFingerprint: done.fingerprint },
      });
      expect(done.oldAnchorRemoved).toBe(true);
      expect(existsSync(oldAnchor)).toBe(false);
      expect(loadOwnerKey(keyDir, NEW).fingerprint).toBe(done.fingerprint);
      expect(retired(keyDir)).toEqual([done.retired]);
      expect(existsSync(stagedStoreDir(storeDir))).toBe(false);
    },
  );

  it(
    'refuses a corrupted log and a store changed since the plan',
    { timeout: SLOW },
    () => {
      const a = fresh();
      const plan = planReplace(a.storeDir);
      appendFileSync(join(a.storeDir, 'trust.log'), '{"seq":9}\n');
      expect(kindOf(() => planReplace(a.storeDir))).toBe(
        'replace_unverified:log_chain',
      );
      expect(
        kindOf(() =>
          replaceStore(a.storeDir, a.keyDir, plan, a.key, NEW, a.init),
        ),
      ).toBe('replace_unverified:log_chain');
      const b = fresh();
      const stale = planReplace(b.storeDir);
      addProfileEnvVar(TrustStore.open(b.storeDir), b.key, 'employee', {
        name: 'QA_PASSWORD',
        kind: 'secret',
      });
      expect(
        kindOf(() =>
          replaceStore(b.storeDir, b.keyDir, stale, b.key, NEW, b.init),
        ),
      ).toBe('store_busy:');
      expect(existsSync(stagedStoreDir(b.storeDir))).toBe(false);
      expect(existsSync(join(b.keyDir, 'owner.key.new'))).toBe(false);
    },
  );

  it(
    'a crash before the old log is marked is started over by the rerun',
    { timeout: SLOW },
    () => {
      const { storeDir, keyDir, key, init } = fresh();
      const plan = planReplace(storeDir);
      expect(() =>
        replaceStoreUntil(storeDir, keyDir, plan, key, NEW, init, 'prepared'),
      ).toThrow('simulated crash');
      const staged = stagedStoreDir(storeDir);
      const newAnchor = TrustStore.open(staged).anchor.location.locator;
      expect(TrustStore.open(storeDir).data.ownerFingerprint).toBe(
        key.fingerprint,
      );
      expect(kindOf(() => loadOwnerKey(keyDir, OLD))).toBe(
        'rotate_incomplete:',
      );
      expect(kindOf(() => recoverRotation(storeDir, keyDir))).toBe(
        'rotate_incomplete:',
      );
      expect(existsSync(join(keyDir, 'owner.key.new'))).toBe(true);
      expect(abandonReplace(storeDir, keyDir)).toBe(true);
      expect(existsSync(staged)).toBe(false);
      expect(existsSync(newAnchor)).toBe(false);
      expect(existsSync(join(keyDir, 'owner.key.new'))).toBe(false);
      expect(abandonReplace(storeDir, keyDir)).toBe(false);
      const done = replaceStore(
        storeDir,
        keyDir,
        planReplace(storeDir),
        loadOwnerKey(keyDir, OLD),
        NEW,
        init,
      );
      expect(TrustStore.open(storeDir).data.ownerFingerprint).toBe(
        done.fingerprint,
      );
    },
  );

  for (const at of ['marked', 'keys'] as const)
    it(
      `a crash after ${at} leaves store_replaced, finished by hand`,
      { timeout: SLOW },
      () => {
        const { storeDir, keyDir, key, init } = fresh();
        const plan = planReplace(storeDir);
        expect(() =>
          replaceStoreUntil(storeDir, keyDir, plan, key, NEW, init, at),
        ).toThrow('simulated crash');
        expect(kindOf(() => TrustStore.open(storeDir))).toBe('store_replaced:');
        expect(kindOf(() => abandonReplace(storeDir, keyDir))).toBe(
          'store_replaced:',
        );
        if (existsSync(join(keyDir, 'owner.key.new'))) {
          renameSync(join(keyDir, 'owner.key'), join(keyDir, 'owner.key.old'));
          renameSync(join(keyDir, 'owner.key.new'), join(keyDir, 'owner.key'));
        }
        renameSync(storeDir, `${storeDir}.replaced-by-hand`);
        expect(kindOf(() => TrustStore.open(storeDir))).toBe('store_replaced:');
        expect(kindOf(() => abandonReplace(storeDir, keyDir))).toBe(
          'store_replaced:',
        );
        renameSync(stagedStoreDir(storeDir), storeDir);
        expect(TrustStore.open(storeDir).data.ownerFingerprint).toBe(
          loadOwnerKey(keyDir, NEW).fingerprint,
        );
      },
    );
});
