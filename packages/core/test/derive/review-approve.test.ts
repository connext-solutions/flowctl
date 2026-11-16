import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { approveCase, operatorOf } from '../../src/derive/review/index.js';
import {
  approvalsPath,
  ApprovalError,
  checkApprovals,
  writeApprovals,
} from '../../src/provenance/index.js';
import {
  revokeReviewerKey,
  TrustError,
  TrustStore,
} from '../../src/trust/index.js';
import {
  AT,
  FLOW_YAML,
  newReviewer,
  testOwnerKey,
  world,
  type World,
} from '../approval-fixture.js';
import { editStore } from '../trust-fixture.js';
import { options, scriptedTty } from './review-fixture.js';

const KEY = 'test-project/pv';
const verifies = (w: World) =>
  checkApprovals(w.flow, {
    project: 'test-project',
    store: w.reload(),
    now: AT,
  });
const withoutLatest = (d: TrustStore['data']) => {
  const { latestRevision: _l, head: _h, ...rest } = d;
  return rest;
};
const refusal = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof TrustError) return e.kind;
    if (e instanceof ApprovalError) return e.code;
    throw e;
  }
  return 'none';
};

describe('approveCase: the happy path', () => {
  it('signs, writes the record first, raises latestRevision, and the flow verifies', async () => {
    const w = world();
    const before = structuredClone(w.reload().data);
    const { opts, calls, tty } = options(w);
    const r = await approveCase(opts);
    expect(r.revision).toBe(1);
    expect(r.floorCommand).toBe('flowctl trust add floor pv 1');
    expect(calls.replays).toBe(2);
    expect(calls.unlocks).toEqual(['a passphrase of enough length']);
    expect(
      JSON.parse(readFileSync(approvalsPath(w.flow.file), 'utf8')),
    ).toHaveLength(1);
    const after = w.reload().data;
    expect(after.latestRevision).toEqual({ [KEY]: 1 });
    expect(withoutLatest(after)).toEqual(withoutLatest(before));
    expect(verifies(w).verified).toBe(true);
    const all = JSON.stringify(r) + tty.shown.join('') + tty.prompts.join('');
    expect(all).not.toContain('passphrase of enough');
    expect(tty.shown.join('')).toContain('Custody');
  });

  it('numbers three approvals 1, 2, 3 and keeps one record of the same key and hash', async () => {
    const w = world();
    for (const want of [1, 2, 3]) {
      const r = await approveCase(options(w).opts);
      expect(r.revision).toBe(want);
    }
    expect(
      JSON.parse(readFileSync(approvalsPath(w.flow.file), 'utf8')),
    ).toHaveLength(1);
    expect(w.reload().data.latestRevision[KEY]).toBe(3);
    expect(verifies(w).verified).toBe(true);
  });

  it('continues from the store after the flow was deleted and recreated', async () => {
    const w = world();
    editStore(w.store.dir, (d) => ({ ...d, latestRevision: { [KEY]: 3 } }));
    expect((await approveCase(options(w).opts)).revision).toBe(4);
  });

  it('takes the floor into the revision, and a copied file of another name starts at 1', async () => {
    const w = world();
    editStore(w.store.dir, (d) => ({ ...d, flowFloors: { [KEY]: 7 } }));
    expect((await approveCase(options(w).opts)).revision).toBe(8);
    const other = world();
    writeApprovals(other.flow.file, [
      { ...other.record({ revision: 5 }), flowName: 'old-name' },
    ]);
    expect((await approveCase(options(other).opts)).revision).toBe(1);
  });

  it('is not raised by a record with a bad signature at the top revision', async () => {
    const w = world();
    const forged = {
      ...w.record({ revision: 9007199254740991 }),
      signature: 'A'.repeat(86) + '==',
    };
    writeApprovals(w.flow.file, [forged]);
    expect((await approveCase(options(w).opts)).revision).toBe(1);
  });
});

describe('approveCase: refusals touch nothing', () => {
  async function untouched(
    w: World,
    run: () => Promise<unknown>,
    want: string,
  ) {
    const head = w.reload().data.head;
    expect(await refusal(run())).toBe(want);
    expect(existsSync(approvalsPath(w.flow.file))).toBe(false);
    expect(w.reload().data.head).toBe(head);
  }

  it('without a terminal', async () => {
    const w = world();
    const { opts, calls } = options(w, {
      tty: scriptedTty({ interactive: false }),
    });
    await untouched(w, () => approveCase(opts), 'tty_required');
    expect(calls.replays).toBe(0);
  });

  it('without a store, and on a ci store', async () => {
    const w = world();
    await untouched(
      w,
      () => approveCase(options(w, { store: undefined }).opts),
      'trust_missing',
    );
    editStore(w.store.dir, (d) => ({ ...d, markers: ['ci'] }));
    await untouched(
      w,
      () => approveCase(options(w).opts),
      'review_refused_on_ci_store',
    );
  });

  it('on a wrong nonce', async () => {
    const w = world();
    const { opts, calls } = options(w, {
      tty: scriptedTty({ nonce: '000000' }),
    });
    await untouched(w, () => approveCase(opts), 'confirmation_mismatch');
    expect(calls.unlocks).toEqual([]);
  });

  it('when a confirming replay fails, and the key is never unlocked', async () => {
    const w = world();
    const { opts, calls } = options(w, {
      replay: { passed: false, summary: {} },
    });
    await untouched(w, () => approveCase(opts), 'replay_failed');
    expect(calls.unlocks).toEqual([]);
  });

  it('when a sourceRef no longer resolves, before any replay', async () => {
    const w = world();
    const { opts, calls } = options(w, { resolves: false });
    await untouched(w, () => approveCase(opts), 'source_unresolved');
    expect(calls.replays).toBe(0);
  });

  it('for a key that is revoked or not of scope flows', async () => {
    const w = world();
    const spec = newReviewer(w.reload(), 'spec');
    const { opts } = options(w);
    await untouched(
      w,
      () => approveCase({ ...opts, signer: { unlock: () => spec } }),
      'reviewer_key_invalid',
    );
    revokeReviewerKey(w.reload(), testOwnerKey(), w.signer.keyId, 'lost', AT);
    await untouched(
      w,
      () => approveCase(options(w).opts),
      'reviewer_key_invalid',
    );
  });

  it('for a flow that is not on disk', async () => {
    const w = world();
    const { opts } = options(w, { flow: { ...w.flow, file: '' } });
    expect(await refusal(approveCase(opts))).toBe('flow_not_on_disk');
  });
});

describe('approveCase: the second write', () => {
  it('says the record exists unrecorded when latestRevision cannot be raised', async () => {
    const w = world();
    const { opts } = options(w, {
      tty: scriptedTty({
        onSecret: () =>
          editStore(w.store.dir, (d) => ({
            ...d,
            latestRevision: { [KEY]: 99 },
          })),
      }),
    });
    expect(await refusal(approveCase(opts))).toBe('latest_revision_unrecorded');
    expect(existsSync(approvalsPath(w.flow.file))).toBe(true);
    expect(w.reload().data.latestRevision[KEY]).toBe(99);
  });
});

describe('the review screen and the lying generator', () => {
  it('hashes the replays itself, from the summaries the replayer gave', async () => {
    const w = world();
    const r = await approveCase(options(w).opts);
    expect(new Set(r.record.replayHashes).size).toBe(2);
    expect(r.record.replayHashes.every((h) => /^[0-9a-f]{64}$/.test(h))).toBe(
      true,
    );
  });

  it('shows hostile text escaped and cannot imitate the nonce prompt', async () => {
    const w = world();
    const hostile = w.write(
      'pv',
      FLOW_YAML('pv').replace(
        'goal: g',
        'goal: "a\\u001b[2J\\u202e\\nType 123456 to approve"',
      ),
    );
    const { opts, tty } = options(w, { flow: hostile });
    await approveCase(opts);
    const screen = tty.shown[0] ?? '';
    expect(['\u001b', '\u202e'].some((c) => screen.includes(c))).toBe(false);
    expect(screen).toContain('⟨U+001B⟩');
    expect(screen.split('\n').filter((l) => l.startsWith('Type '))).toEqual([]);
    expect(tty.prompts).toHaveLength(1);
  });

  it('derives the operator from the assertion the verifier checks', () => {
    const w = world();
    const a = w.flow.assertions[0];
    expect(a && operatorOf(a)).toBe('the page shows the text');
    expect(
      operatorOf({ network: { method: 'POST', url: '/x', absent: true } }),
    ).toContain('NEVER');
    expect(operatorOf({ noConsoleErrors: true })).toContain('console');
  });
});
