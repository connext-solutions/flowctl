import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeClosure } from '../src/trust/closure/index.js';
import { type ConfirmDigestInput, planConfirm } from '../src/trust/index.js';

/**
 * The confirmation digest of ADR 0024 section 5: it binds the flow file, its uploads, its hook closures (under the
 * narrower allowlist of a confirmation) and the effective vars, and a flow it cannot bind is unconfirmable.
 */
function root(): string {
  const dir = mkdtempSync(join(tmpdir(), 'flowctl-digest-'));
  mkdirSync(join(dir, 'fixtures'));
  mkdirSync(join(dir, '.hook-tmp'));
  writeFileSync(join(dir, 'items-crud.yaml'), 'name: items-crud\n');
  writeFileSync(join(dir, 'fixtures', 'a.csv'), 'ma,ten\n');
  writeFileSync(join(dir, 'seed.sh'), '#!/bin/sh\necho seeded\n');
  return dir;
}

const input = (
  dir: string,
  over: Partial<ConfirmDigestInput> = {},
): ConfirmDigestInput => ({
  root: dir,
  flowFile: 'items-crud.yaml',
  uploads: ['fixtures/a.csv'],
  setup: './seed.sh',
  teardown: 'sleep 1',
  vars: { org: 'demo' },
  envInputs: false,
  ...over,
});

describe('planConfirm', () => {
  it('gives a stable 64-character digest for a confirmable flow, with every file it binds', () => {
    const dir = root();
    const a = planConfirm(input(dir));
    expect(a.refusals).toEqual([]);
    expect(a.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(planConfirm(input(dir)).digest).toBe(a.digest);
    expect(a.files.map((f) => f.path)).toEqual(['fixtures/a.csv']);
    expect(a.hooks.setup?.files.map((f) => f.path)).toEqual(['seed.sh']);
  });

  it.each([
    [
      'the flow file',
      (d: string) =>
        writeFileSync(join(d, 'items-crud.yaml'), 'name: items-crud\n# x\n'),
    ],
    [
      'an upload',
      (d: string) =>
        writeFileSync(join(d, 'fixtures', 'a.csv'), 'ma,ten\n1,An\n'),
    ],
    [
      'a script the setup hook runs',
      (d: string) =>
        writeFileSync(join(d, 'seed.sh'), '#!/bin/sh\necho other\n'),
    ],
  ])('changes when %s changes', (_what, edit) => {
    const dir = root();
    const before = planConfirm(input(dir)).digest;
    edit(dir);
    expect(planConfirm(input(dir)).digest).not.toBe(before);
  });

  it('changes with a var value and with the hook text', () => {
    const dir = root();
    const base = planConfirm(input(dir)).digest;
    expect(planConfirm(input(dir, { vars: { org: 'other' } })).digest).not.toBe(
      base,
    );
    expect(planConfirm(input(dir, { teardown: 'sleep 2' })).digest).not.toBe(
      base,
    );
  });

  it.each([
    'rm -f ./.hook-tmp/x',
    'curl https://api.example.com/reset',
    'psql -c "delete from items"',
    'cp ./seed.sh ./.hook-tmp/x',
  ])(
    'refuses a hook that runs %s, which hook consent alone may accept',
    (hook) => {
      const dir = root();
      const plan = planConfirm(input(dir, { teardown: hook }));
      expect(plan.digest).toBe('');
      expect(plan.refusals.join(' ')).toContain('teardown hook is uncovered');
      if (hook.startsWith('rm') || hook.startsWith('cp'))
        expect(computeClosure({ root: dir, teardown: hook }).uncovered).toEqual(
          [],
        );
    },
  );

  it('refuses a flow with an env input, and an upload behind a symlink', () => {
    const dir = root();
    expect(
      planConfirm(input(dir, { envInputs: true })).refusals.join(' '),
    ).toContain('env input');
    symlinkSync(join(dir, 'fixtures', 'a.csv'), join(dir, 'fixtures', 'b.csv'));
    const plan = planConfirm(input(dir, { uploads: ['fixtures/b.csv'] }));
    expect(plan.digest).toBe('');
    expect(plan.refusals.join(' ')).toContain('fixtures/b.csv');
  });
});
