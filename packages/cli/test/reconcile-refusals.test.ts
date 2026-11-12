import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  captureOutput,
  controls,
  elsewhere,
  io,
  MAP,
  project,
  reconcile,
  runJson,
  saveRun,
} from './reconcile-helpers.js';

/** `flowctl reconcile` refusals: no file text in errors, dot-folder roots, links and files it must not replace. */
captureOutput();

describe('flowctl reconcile: no file text or fs message in errors', () => {
  it('a run.json with raw control bytes exits 2 with a fixed reason and no control character on stderr', async () => {
    const p = project();
    mkdirSync(join(p.runs, 'r_j1'));
    writeFileSync(join(p.runs, 'r_j1', 'run.json'), '\u001b]0;x\u0007');
    expect(await reconcile(p, 'r_j1')).toBe(2);
    const text = io.err.join('');
    expect(text).toContain('(not valid JSON)');
    expect(controls(text)).toEqual([]);
  });

  it('a missing run.json names only the error code', async () => {
    const p = project();
    mkdirSync(join(p.runs, 'r_j2'));
    expect(await reconcile(p, 'r_j2')).toBe(2);
    expect(io.err.join('')).toContain('run.json (ENOENT)');
  });

  it('an existing gaps.json with raw control bytes is refused without its text', async () => {
    const p = project();
    saveRun(p, 'r_j3');
    writeFileSync(join(p.runs, 'r_j3', 'appmap.json'), MAP);
    mkdirSync(join(p.flows, 'gaps'));
    writeFileSync(join(p.flows, 'gaps', 'gaps.json'), '\u001b]0;x\u0007');
    expect(await reconcile(p, '--gaps')).toBe(2);
    expect(controls(io.err.join(''))).toEqual([]);
    expect(io.err.join('')).toContain('not a gaps report');
  });

  it('names "the latest run\'s appmap.json" when --gaps picked a map that is not an AppMap', async () => {
    const p = project();
    saveRun(p, 'r_j4');
    writeFileSync(join(p.runs, 'r_j4', 'appmap.json'), '\u001b]0;x\u0007');
    expect(await reconcile(p, '--gaps')).toBe(2);
    expect(io.err.join('')).toContain(
      "the latest run's appmap.json is not an AppMap",
    );
    expect(io.err.join('')).not.toContain('--appmap');
    expect(controls(io.err.join(''))).toEqual([]);
  });
});

describe('flowctl reconcile: refused roots and links', () => {
  it.each([
    ['--code', '.runs'],
    ['--spec', '.auth'],
  ])(
    '%s <flows>/%s is a dot folder of the project: exit 2',
    async (flag, dir) => {
      const p = project();
      saveRun(p, 'r_k1');
      mkdirSync(join(p.flows, dir), { recursive: true });
      expect(await reconcile(p, 'r_k1', flag, join(p.flows, dir))).toBe(2);
      expect(io.err.join('')).toContain('dot folder');
      expect(existsSync(join(p.runs, 'r_k1', 'classification.json'))).toBe(
        false,
      );
    },
  );

  it('checks --code before --out creates a directory', async () => {
    const p = project();
    saveRun(p, 'r_k2');
    writeFileSync(join(p.runs, 'r_k2', 'appmap.json'), MAP);
    const out = join(p.flows, 'new', 'gaps');
    expect(
      await reconcile(p, '--gaps', '--code', elsewhere(), '--out', out),
    ).toBe(2);
    expect(existsSync(join(p.flows, 'new'))).toBe(false);
  });

  it('refuses a symlinked run.json', async () => {
    const p = project();
    const target = join(elsewhere(), 'run.json');
    writeFileSync(target, runJson('r_k3'));
    mkdirSync(join(p.runs, 'r_k3'));
    symlinkSync(target, join(p.runs, 'r_k3', 'run.json'));
    expect(await reconcile(p, 'r_k3')).toBe(2);
    expect(io.err.join('')).toContain('symlink');
  });

  it('refuses a symlinked .runs and writes nothing through it', async () => {
    const p = project();
    const real = elsewhere();
    mkdirSync(join(real, 'r_k4'));
    writeFileSync(join(real, 'r_k4', 'run.json'), runJson('r_k4'));
    rmSync(p.runs, { recursive: true });
    symlinkSync(real, p.runs);
    expect(await reconcile(p, 'r_k4')).toBe(2);
    expect(existsSync(join(real, 'r_k4', 'classification.json'))).toBe(false);
  });

  it('refuses a symlink already at classification.json and leaves its target alone', async () => {
    const p = project();
    saveRun(p, 'r_k5');
    const target = join(elsewhere(), 'keep.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(p.runs, 'r_k5', 'classification.json'));
    expect(await reconcile(p, 'r_k5')).toBe(2);
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('refuses an --appmap that is a symlink or under .auth', async () => {
    const p = project();
    saveRun(p, 'r_k6');
    const target = join(elsewhere(), 'appmap.json');
    writeFileSync(target, MAP);
    symlinkSync(target, join(p.flows, 'linked.json'));
    mkdirSync(join(p.flows, '.auth'));
    writeFileSync(join(p.flows, '.auth', 'appmap.json'), MAP);
    for (const file of [
      join(p.flows, 'linked.json'),
      join(p.flows, '.auth', 'appmap.json'),
    ]) {
      expect(await reconcile(p, 'r_k6', '--appmap', file), file).toBe(2);
      expect(existsSync(join(p.runs, 'r_k6', 'classification.json'))).toBe(
        false,
      );
    }
  });

  it('refuses an --out that holds a gaps.md without a gaps.json beside it', async () => {
    const p = project();
    saveRun(p, 'r_k7');
    writeFileSync(join(p.runs, 'r_k7', 'appmap.json'), MAP);
    mkdirSync(join(p.flows, 'notes'));
    writeFileSync(join(p.flows, 'notes', 'gaps.md'), '# mine\n');
    expect(await reconcile(p, '--gaps', '--out', join(p.flows, 'notes'))).toBe(
      2,
    );
    expect(readFileSync(join(p.flows, 'notes', 'gaps.md'), 'utf8')).toBe(
      '# mine\n',
    );
  });
});
