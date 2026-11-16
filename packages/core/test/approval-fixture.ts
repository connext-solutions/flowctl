import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFlow, type Flow } from '../src/flow/index.js';
import {
  assertionHash,
  checkApprovals,
  encodeApprovalPayload,
  evidenceHash,
  flowContentHash,
  payloadOf,
  writeApprovals,
  type ApprovalCheck,
  type CaseApprovalRecord,
} from '../src/provenance/index.js';
import {
  addReviewerKey,
  reviewerKeyId,
  TrustStore,
  type ReviewerSigner,
} from '../src/trust/index.js';
import { testOwnerKey, testStore } from './trust-fixture.js';
import { cfg, NOW, REQ } from './trust-keys-fixture.js';

export const AT = new Date('2026-01-10T00:00:00.000Z');
export const HEX = 'c'.repeat(64);

export const FLOW_YAML = (name: string, extra = ''): string => `name: ${name}
goal: g
profile: employee
start: /x
derived: true
steps:
  - click: { testId: go }
assertions:
  - text: "Total"
    sourceRef: { kind: invariant, ref: inv-1 }
${extra}`;

/** A reviewer key pair whose public half the store holds; `sign` is the key's signer. */
export function newReviewer(
  store: TrustStore,
  scope: 'flows' | 'spec' = 'flows',
  days = 30,
): ReviewerSigner {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ format: 'der', type: 'spki' });
  const raw = Buffer.from(der.subarray(der.length - 32));
  addReviewerKey(
    store,
    testOwnerKey(),
    raw,
    { ...REQ, scope, days },
    'declared-file',
    NOW,
  );
  return {
    publicKey: raw,
    keyId: reviewerKeyId(raw),
    sign: (m) => sign(null, m, privateKey).toString('base64'),
  };
}

export interface World {
  store: TrustStore;
  flowsPath: string;
  signer: ReviewerSigner;
  flow: Flow;
  reload(): TrustStore;
  write(name: string, yaml: string): Flow;
  record(
    overrides?: Partial<CaseApprovalRecord>,
    as?: ReviewerSigner,
    flow?: Flow,
  ): CaseApprovalRecord;
}

/** A store with one `flows` reviewer key, and a derived flow `pv` on disk. */
export function world(): World {
  const c = cfg();
  mkdirSync(c.flowsPath, { recursive: true });
  const store = testStore(c);
  const signer = newReviewer(store);
  const write = (name: string, yaml: string): Flow => {
    const file = join(c.flowsPath, `${name}.yaml`);
    writeFileSync(file, yaml);
    return loadFlow(file, ['employee']);
  };
  const w: World = {
    store: TrustStore.open(store.dir),
    flowsPath: c.flowsPath,
    signer,
    flow: write('pv', FLOW_YAML('pv')),
    reload: () => (w.store = TrustStore.open(store.dir)),
    write,
    record: (overrides = {}, as = signer, flow = w.flow) => {
      const base = {
        project: 'test-project',
        flowName: flow.name,
        flowHash: flowContentHash(flow),
        revision: 1,
        keyId: as.keyId,
        approvedAt: '2026-01-05T00:00:00.000Z',
        assertions: flow.assertions.map((a) => ({
          hash: assertionHash(a),
          ...(a.sourceRef === undefined ? {} : { sourceRef: a.sourceRef }),
          polarity: 'positive' as const,
        })),
        replayHashes: [evidenceHash({ n: 1 }), evidenceHash({ n: 2 })],
        evidenceHash: evidenceHash({ map: 1 }),
        ...overrides,
      };
      const signature = as.sign(encodeApprovalPayload(base));
      return { v: 1, ...base, signature };
    },
  };
  return w;
}

/** Writes `records` as the approvals file of `extra.flow` (the world's flow by default) and checks it. */
export function checkRecords(
  w: World,
  records: unknown[],
  extra: {
    mergeBaseRevision?: number;
    hasDuplicateStem?: boolean;
    now?: Date;
    flow?: Flow;
  } = {},
): ApprovalCheck {
  const flow = extra.flow ?? w.flow;
  writeApprovals(flow.file, records);
  return checkApprovals(flow, {
    project: 'test-project',
    store: w.reload(),
    now: extra.now ?? AT,
    ...extra,
  });
}

export { payloadOf, testOwnerKey, NOW };
