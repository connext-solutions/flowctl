import { execFileSync } from 'node:child_process';
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import {
  ByteBudget,
  ContainmentError,
  openRoot,
  readContained,
  requirePurpose,
  walkContained,
} from '../src/trust/index.js';

const tmp = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'flowctl-contain-')));

const put = (
  root: string,
  rel: string,
  body: string | Buffer = 'x',
): string => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
};

const MAX = { maxBytes: 1024 };

/** The refusal `fn` throws, so a test can check its kind and rule. */
const refusal = (fn: () => unknown): ContainmentError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ContainmentError) return e;
    throw e;
  }
  throw new Error('expected a ContainmentError');
};

describe('openRoot', () => {
  it('resolves an absolute directory once and refuses a relative one or a file', () => {
    const dir = tmp();
    expect(openRoot(dir, 'specs')).toMatchObject({
      path: dir,
      purpose: 'specs',
    });
    expect(refusal(() => openRoot('specs', 'specs')).kind).toBe(
      'path_not_contained',
    );
    expect(refusal(() => openRoot(put(dir, 'f'), 'specs')).kind).toBe(
      'path_not_contained',
    );
    expect(refusal(() => openRoot(join(dir, 'nope'), 'specs')).kind).toBe(
      'not_found',
    );
  });

  it('refuses a root of another purpose', () => {
    const root = openRoot(tmp(), 'contracts');
    expect(refusal(() => requirePurpose(root, 'specs')).rule).toBe('purpose');
    expect(() => requirePurpose(root, 'contracts')).not.toThrow();
  });

  it('refuses reads once the root directory was swapped', () => {
    const dir = tmp();
    put(dir, 'a.md');
    const root = openRoot(dir, 'specs');
    renameSync(dir, `${dir}-old`);
    mkdirSync(dir);
    put(dir, 'a.md');
    expect(refusal(() => readContained(root, 'a.md', MAX)).rule).toBe(
      'root changed',
    );
  });
});

describe('readContained', () => {
  it('reads a regular file inside the root', () => {
    const dir = tmp();
    put(dir, 'leave/submit.md', 'hello');
    const root = openRoot(dir, 'specs');
    expect(readContained(root, 'leave/submit.md', MAX).toString()).toBe(
      'hello',
    );
  });

  it('is a ConfigError, so existing handlers catch it', () => {
    const root = openRoot(tmp(), 'specs');
    expect(() => readContained(root, '../x', MAX)).toThrow(ConfigError);
  });

  it.each([
    ['../outside.md', 'no . or .. component'],
    ['a/../../outside.md', 'no . or .. component'],
    ['./a.md', 'no . or .. component'],
    ['/etc/passwd', 'must be relative'],
    ['~/x', 'must be relative'],
    ['C:/x', 'must be relative'],
    ['a\\b', 'no NUL or backslash'],
    ['a\0b', 'no NUL or backslash'],
    ['a//b', 'empty component'],
    ['a/', 'empty component'],
    ['.env', 'no dot-prefixed component'],
    ['.GIT/config', 'no dot-prefixed component'],
    ['docs/.auth/x', 'no dot-prefixed component'],
    ['a.md:stream', 'no Windows form'],
    ['a.md.', 'no Windows form'],
    ['a.md ', 'no Windows form'],
    ['cafe\u0301.md', 'not_nfc'],
    [Array.from({ length: 17 }, () => 'd').join('/'), 'too deep'],
  ])('refuses %j before touching the file system (%s)', (rel, rule) => {
    const root = openRoot(tmp(), 'specs');
    const e = refusal(() => readContained(root, rel, MAX));
    expect(e.kind).toBe('path_not_contained');
    expect(e.rule).toBe(rule);
  });

  it('refuses a symlink that points out of the root', () => {
    const dir = tmp();
    const secret = put(tmp(), 'secret.txt', 'top secret');
    symlinkSync(secret, join(dir, 'a.md'));
    const e = refusal(() => readContained(openRoot(dir, 'specs'), 'a.md', MAX));
    expect(e.rule).toBe('no symbolic link');
    expect(e.message).not.toContain('top secret');
  });

  it('refuses a symlinked intermediate directory, even one pointing inside', () => {
    const dir = tmp();
    put(dir, 'real/a.md');
    symlinkSync(join(dir, 'real'), join(dir, 'linked'));
    const root = openRoot(dir, 'specs');
    expect(refusal(() => readContained(root, 'linked/a.md', MAX)).rule).toBe(
      'no symbolic link',
    );
  });

  it('refuses a hard link, whose second name may lie outside the root', () => {
    const dir = tmp();
    const outside = put(tmp(), 'secret.txt');
    linkSync(outside, join(dir, 'a.md'));
    expect(
      refusal(() => readContained(openRoot(dir, 'specs'), 'a.md', MAX)).rule,
    ).toBe('no hard link');
  });

  it('refuses a FIFO without blocking on it', () => {
    const dir = tmp();
    execFileSync('mkfifo', [join(dir, 'pipe.md')]);
    expect(
      refusal(() => readContained(openRoot(dir, 'specs'), 'pipe.md', MAX)).rule,
    ).toBe('must be a regular file');
  });

  it('refuses a directory and a path through a file', () => {
    const dir = tmp();
    put(dir, 'a/b.md');
    const root = openRoot(dir, 'specs');
    expect(refusal(() => readContained(root, 'a', MAX)).rule).toBe(
      'must be a regular file',
    );
    expect(refusal(() => readContained(root, 'a/b.md/c', MAX)).rule).toBe(
      'must be a directory',
    );
  });

  it('refuses a file over the cap without reading it', () => {
    const dir = tmp();
    put(dir, 'big.md', Buffer.alloc(4096, 0x61));
    const e = refusal(() =>
      readContained(openRoot(dir, 'specs'), 'big.md', MAX),
    );
    expect(e.kind).toBe('too_large');
  });

  it('reports a missing file as not_found', () => {
    const root = openRoot(tmp(), 'specs');
    expect(refusal(() => readContained(root, 'none/a.md', MAX)).kind).toBe(
      'not_found',
    );
  });
});

describe('walkContained', () => {
  it('lists regular files in byte order and leaves dot names out silently', () => {
    const dir = tmp();
    put(dir, 'b.md');
    put(dir, 'a/z.md');
    put(dir, 'a/b.md');
    put(dir, '.git/config');
    put(dir, '.env');
    const { files, skipped } = walkContained(openRoot(dir, 'specs'));
    expect(files.map((f) => f.path)).toEqual(['a/b.md', 'a/z.md', 'b.md']);
    expect(skipped).toEqual([]);
  });

  it('reports links, hard links, FIFOs, non-NFC names and oversized files as skipped', () => {
    const dir = tmp();
    const outside = tmp();
    put(outside, 'secret.md');
    put(dir, 'ok.md');
    symlinkSync(join(outside, 'secret.md'), join(dir, 'link.md'));
    symlinkSync(outside, join(dir, 'linkdir'));
    linkSync(put(outside, 'hard.md'), join(dir, 'hard.md'));
    execFileSync('mkfifo', [join(dir, 'pipe.md')]);
    put(dir, 'cafe\u0301.md');
    put(dir, 'big.md', Buffer.alloc(2048));
    const { files, skipped } = walkContained(openRoot(dir, 'specs'), {
      maxFileBytes: 1024,
    });
    expect(files.map((f) => f.path)).toEqual(['ok.md']);
    expect(skipped).toEqual(
      expect.arrayContaining([
        { path: 'link.md', rule: 'no symbolic link' },
        { path: 'linkdir', rule: 'no symbolic link' },
        { path: 'hard.md', rule: 'no hard link' },
        { path: 'pipe.md', rule: 'must be a regular file' },
        { path: 'big.md', rule: 'file size' },
      ]),
    );
    expect(skipped.map((s) => s.rule)).toContain('not_nfc');
  });

  it('refuses a tree deeper than the cap', () => {
    const dir = tmp();
    put(dir, `${Array.from({ length: 20 }, (_, i) => `d${i}`).join('/')}/a.md`);
    const e = refusal(() => walkContained(openRoot(dir, 'specs')));
    expect(e).toMatchObject({ kind: 'too_large', rule: 'too deep' });
  });

  it('refuses too many entries and too many bytes in total', () => {
    const dir = tmp();
    for (let i = 0; i < 30; i++) put(dir, `f${i}.md`, Buffer.alloc(100));
    const root = openRoot(dir, 'specs');
    expect(refusal(() => walkContained(root, { maxEntries: 10 })).kind).toBe(
      'too_large',
    );
    expect(refusal(() => walkContained(root, { maxBytes: 1000 })).kind).toBe(
      'too_large',
    );
    expect(walkContained(root).files).toHaveLength(30);
  });

  it('walks a subdirectory only when it is a real directory inside the root', () => {
    const dir = tmp();
    put(dir, 'docs/a.md');
    symlinkSync(join(dir, 'docs'), join(dir, 'alias'));
    const root = openRoot(dir, 'specs');
    expect(walkContained(root, {}, 'docs').files.map((f) => f.path)).toEqual([
      'docs/a.md',
    ]);
    expect(refusal(() => walkContained(root, {}, 'alias')).kind).toBe(
      'path_not_contained',
    );
    expect(refusal(() => walkContained(root, {}, '../x')).kind).toBe(
      'path_not_contained',
    );
  });

  it('does not enter a pruned directory name, at any depth, but lists a file of that name', () => {
    const dir = tmp();
    put(dir, 'node_modules/x/a.md');
    put(dir, 'src/node_modules/b.md');
    put(dir, 'src/dist');
    for (let i = 0; i < 20; i++) put(dir, `dist/f${i}.md`);
    const root = openRoot(dir, 'specs');
    const walked = walkContained(root, { maxEntries: 10 }, undefined, {
      prune: new Set(['node_modules', 'dist']),
    });
    expect(walked.files.map((f) => f.path)).toEqual(['src/dist']);
    expect(walked.skipped).toEqual([]);
  });
});

describe('ByteBudget', () => {
  it('counts pieces and refuses past the limit', () => {
    const b = new ByteBudget(10, 'decompressed bytes');
    b.take(6);
    b.take(4);
    expect(b.total).toBe(10);
    expect(refusal(() => b.take(1))).toMatchObject({
      kind: 'too_large',
      rule: 'decompressed bytes',
    });
  });
});
