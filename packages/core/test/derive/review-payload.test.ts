import { existsSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  approveCase,
  type ApproveOptions,
} from '../../src/derive/review/index.js';
import { approvalsPath, ApprovalError } from '../../src/provenance/index.js';
import { TrustError } from '../../src/trust/index.js';
import { FLOW_YAML, world, type World } from '../approval-fixture.js';
import { options } from './review-fixture.js';

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

const baselineFlow = (w: World, value: string): World['flow'] =>
  w.write(
    'pv',
    FLOW_YAML('pv')
      .replace('text: "Total"', `text: "${value}"`)
      .replace('kind: invariant, ref: inv-1', 'kind: baseline, ref: b-1'),
  );

/** Runs one approval that must be refused with `want`: nothing signed, no file written, the store unchanged. */
async function refusedUntouched(
  w: World,
  over: Parameters<typeof options>[1],
  want: string,
): Promise<{ replays: number; prompts: number }> {
  const head = w.reload().data.head;
  const { opts, calls, tty } = options(w, over);
  expect(await refusal(approveCase(opts))).toBe(want);
  expect(calls.unlocks).toEqual([]);
  expect(existsSync(approvalsPath(opts.flow.file))).toBe(false);
  const after = w.reload().data;
  expect(after.head).toBe(head);
  expect(after.latestRevision).toEqual({});
  return { replays: calls.replays, prompts: tty.prompts.length };
}

describe('approveCase: the payload is checked by the record schema before anything is signed', () => {
  it.each([0, 9, 1.5])('refuses %s confirming replays', async (replays) => {
    const w = world();
    const r = await refusedUntouched(w, { replays }, 'replay_count_invalid');
    expect(r.replays).toBe(0);
  });

  it('refuses a baseline value over 500 characters', async () => {
    const w = world();
    const long = 'x'.repeat(501);
    const flow = baselineFlow(w, long);
    await refusedUntouched(
      w,
      {
        flow,
        baseline: { value: long, evidence: 'e' },
        replay: { passed: true, summary: {}, baselineSeen: [long] },
      },
      'payload_invalid',
    );
  });

  it('refuses baseline evidence over 2000 characters', async () => {
    const w = world();
    const flow = baselineFlow(w, '7');
    await refusedUntouched(
      w,
      {
        flow,
        baseline: { value: '7', evidence: 'e'.repeat(2001) },
        replay: { passed: true, summary: {}, baselineSeen: ['7'] },
      },
      'payload_invalid',
    );
  });

  it('refuses a number label over 100 characters', async () => {
    const w = world();
    const numbers: ApproveOptions['numbers'] = [
      { label: 'L'.repeat(101), unit: 'VND' },
    ];
    await refusedUntouched(w, { numbers }, 'payload_invalid');
  });

  it('refuses more than 200 assertions', async () => {
    const w = world();
    const extra = Array.from({ length: 200 }, (_, i) => `  - text: "a${i}"`);
    const flow = w.write('pv', FLOW_YAML('pv', `${extra.join('\n')}\n`));
    expect(flow.assertions).toHaveLength(201);
    await refusedUntouched(w, { flow }, 'payload_invalid');
  });
});

describe('approveCase: an approvals file it cannot read is refused before any replay or prompt', () => {
  it.each<[string, (file: string, dir: string) => void]>([
    [
      'with merge conflict markers',
      (file) =>
        writeFileSync(file, '<<<<<<< HEAD\n[]\n=======\n[]\n>>>>>>> other\n'),
    ],
    [
      'that is a symlink',
      (file, dir) => {
        const target = join(dir, 'elsewhere.json');
        writeFileSync(target, '[]');
        symlinkSync(target, file);
      },
    ],
    [
      'over 1 MiB',
      (file) => writeFileSync(file, `[${' '.repeat(1024 * 1024)}]`),
    ],
  ])('%s', async (_name, damage) => {
    const w = world();
    damage(approvalsPath(w.flow.file), w.flowsPath);
    const head = w.reload().data.head;
    const { opts, calls, tty } = options(w);
    expect(await refusal(approveCase(opts))).toBe('approvals_unreadable');
    expect(calls.replays).toBe(0);
    expect(calls.resolves).toBe(0);
    expect(tty.prompts).toEqual([]);
    expect(w.reload().data.head).toBe(head);
  });
});

describe('the review screen shows the whole hashed flow, uncut', () => {
  it('shows every top-level field of the flow content hash', async () => {
    const w = world();
    const flow = w.write(
      'pv',
      FLOW_YAML('pv')
        .replace(
          'goal: g',
          'goal: g\ntags: [tag-one]\nsetup: ./up.sh\nteardown: ./down.sh',
        )
        .replace(
          'start: /x',
          'start: /start-here\ninputs:\n  who: { env: WHO_VAR }\n  what: { value: plain-value }\nrecorded: { by: rec-value }',
        ),
    );
    const { opts, tty } = options(w, { flow });
    await approveCase(opts);
    const screen = tty.shown.join('\n');
    for (const shown of [
      'tag-one',
      './up.sh',
      './down.sh',
      '/start-here',
      'employee',
      'WHO_VAR',
      'plain-value',
      'rec-value',
      'Derived: yes',
      'testId',
      'Total',
    ])
      expect(screen).toContain(shown);
  });

  it('refuses a step longer than the screen shows', async () => {
    const w = world();
    const flow = w.write(
      'pv',
      FLOW_YAML('pv').replace(
        'click: { testId: go }',
        `click: { testId: "${'s'.repeat(501)}" }`,
      ),
    );
    const r = await refusedUntouched(w, { flow }, 'screen_truncated');
    expect(r.prompts).toBe(0);
  });
});
