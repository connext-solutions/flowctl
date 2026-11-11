import {
  chmodSync,
  linkSync,
  mkdirSync,
  renameSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildCodeIndex,
  type RouteExtractor,
} from '../../src/reconcile/index.js';
import { ContainmentError, openRoot } from '../../src/trust/index.js';
import { put, tmp } from './repo.js';

const index = (
  dir: string,
  opts: Parameters<typeof buildCodeIndex>[1] = {},
): ReturnType<typeof buildCodeIndex> =>
  buildCodeIndex(openRoot(dir, 'repos'), opts);

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

const LABEL = '{"a": "Gửi đơn"}';

/** An extractor that finds nothing and runs `fn` when the build reaches `target`, after reading it. */
const onRead = (target: string, fn: () => void): RouteExtractor => ({
  name: 'on-read',
  reads: (rel) => {
    if (rel === target) fn();
    return false;
  },
  fromSource: () => ({ routes: [], skipped: [] }),
});

describe('hostile repositories', () => {
  it('does not follow a symbolic link out of the root, to a file or a folder', () => {
    const outside = tmp();
    put(outside, 'vi.json', LABEL);
    put(outside, 'locales/vi.json', LABEL);
    const dir = tmp();
    mkdirSync(join(dir, 'locales'));
    symlinkSync(join(outside, 'vi.json'), join(dir, 'locales/vi.json'));
    symlinkSync(join(outside, 'locales'), join(dir, 'i18n'));
    const idx = index(dir);
    expect(idx.labels).toEqual([]);
    expect(idx.skipped).toEqual([
      { path: 'i18n', rule: 'no symbolic link' },
      { path: 'locales/vi.json', rule: 'no symbolic link' },
    ]);
  });

  it('refuses a hard link out of the root', () => {
    const outside = tmp();
    const target = put(outside, 'vi.json', LABEL);
    const dir = tmp();
    mkdirSync(join(dir, 'locales'));
    linkSync(target, join(dir, 'locales/vi.json'));
    expect(index(dir).skipped).toEqual([
      { path: 'locales/vi.json', rule: 'no hard link' },
    ]);
  });

  it('refuses path traversal, absolute paths and links in the folders it is given', () => {
    const dir = tmp();
    put(dir, 'src/a.ts', '');
    symlinkSync(tmp(), join(dir, 'linked'));
    for (const sub of ['../x', '/etc', 'src/../..', '.git', 'linked'])
      expect(refusal(() => index(dir, { dirs: [sub] })).kind).toBe(
        'path_not_contained',
      );
  });

  it('skips a file over the per-file cap without reading it', () => {
    const dir = tmp();
    put(dir, 'locales/vi.json', `{"a": "${'x'.repeat(2048)}"}`);
    const idx = index(dir, { limits: { maxFileBytes: 1024 } });
    expect(idx.skipped).toEqual([
      { path: 'locales/vi.json', rule: 'file size' },
    ]);
  });

  it('refuses the whole index past the file, byte or record budget', () => {
    const dir = tmp();
    for (let i = 0; i < 4; i++) put(dir, `src/a${i}.ts`, 'x'.repeat(100));
    expect(refusal(() => index(dir, { limits: { maxFiles: 3 } })).kind).toBe(
      'too_large',
    );
    expect(refusal(() => index(dir, { limits: { maxBytes: 300 } })).kind).toBe(
      'too_large',
    );
    put(dir, 'locales/vi.json', '{"a": "1", "b": "2", "c": "3"}');
    expect(refusal(() => index(dir, { limits: { maxRecords: 2 } })).rule).toBe(
      'index records',
    );
  });

  it('skips binary files, UTF-16 and invalid UTF-8, and reads non-NFC text as NFC', () => {
    const dir = tmp();
    put(dir, 'locales/bin.json', Buffer.from([0x7b, 0x00, 0x7d]));
    put(
      dir,
      'locales/u16.json',
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('{}', 'utf16le')]),
    );
    put(dir, 'locales/bad.json', Buffer.from([0x7b, 0xc3, 0x28, 0x7d]));
    put(dir, 'locales/vi.json', '{"a": "Đa\u0303 gửi", "b": "x\u200by"}');
    put(dir, 'locales/broken.json', '{"a": ');
    const idx = index(dir);
    expect(idx.skipped).toEqual([
      { path: 'locales/bad.json', rule: 'not utf-8' },
      { path: 'locales/bin.json', rule: 'binary' },
      { path: 'locales/broken.json', rule: 'invalid json' },
      { path: 'locales/u16.json', rule: 'not utf-8' },
      {
        path: 'locales/vi.json',
        line: 1,
        rule: 'hidden or unassigned character',
      },
    ]);
    expect(idx.findLabel('Đã gửi').matches).toHaveLength(1);
  });

  it('skips a file whose name is not NFC and never reads dot folders', () => {
    const dir = tmp();
    put(dir, 'locales/vi\u0301.json', LABEL);
    put(dir, '.git/locales/vi.json', LABEL);
    put(dir, 'src/.env', 'SECRET=1');
    const idx = index(dir);
    expect(idx.labels).toEqual([]);
    expect(idx.skipped).toEqual([
      { path: 'locales/vi\u0301.json', rule: 'not_nfc' },
    ]);
  });

  it('refuses a root swapped while it is read, between reads and after the last one', () => {
    let dir = tmp();
    const swapOn = (target: string): RouteExtractor =>
      onRead(target, () => {
        renameSync(dir, `${dir}-old`);
        mkdirSync(dir);
      });
    put(dir, 'src/a.ts', '');
    put(dir, 'src/b.ts', '');
    const root = openRoot(dir, 'repos');
    expect(
      refusal(() => buildCodeIndex(root, { routes: [swapOn('src/a.ts')] })),
    ).toMatchObject({ kind: 'path_not_contained', rule: 'root changed' });
    dir = tmp();
    put(dir, 'src/a.ts', '');
    const last = openRoot(dir, 'repos');
    expect(
      refusal(() => buildCodeIndex(last, { routes: [swapOn('src/a.ts')] })),
    ).toMatchObject({ kind: 'path_not_contained', rule: 'root changed' });
  });

  it.skipIf(process.getuid?.() === 0)(
    'skips a file it may not read as unreadable',
    () => {
      const dir = tmp();
      const file = put(dir, 'locales/vi.json', LABEL);
      chmodSync(file, 0o000);
      try {
        expect(index(dir).skipped).toEqual([
          { path: 'locales/vi.json', rule: 'unreadable' },
        ]);
      } finally {
        chmodSync(file, 0o644);
      }
    },
  );

  it('counts skipped entries against the record budget', () => {
    const dir = tmp();
    const rows = Array.from({ length: 5 }, (_, i) => `"k${i}": "a\u200bb"`);
    put(dir, 'locales/vi.json', `{${rows.join(',')}}`);
    expect(index(dir, { limits: { maxRecords: 5 } }).skipped).toHaveLength(5);
    expect(refusal(() => index(dir, { limits: { maxRecords: 4 } })).rule).toBe(
      'index records',
    );
  });

  it('neither lists nor charges files it never reads', () => {
    const dir = tmp();
    put(dir, 'public/logo.png', Buffer.alloc(4096));
    put(dir, 'docs/guide.md', 'x'.repeat(4096));
    put(dir, 'locales/vi.json', LABEL);
    const idx = index(dir, { limits: { maxBytes: 1024 } });
    expect(idx.labels).toHaveLength(1);
    expect(idx.skipped).toEqual([]);
  });

  it('charges the bytes it actually read, not the size the walk saw', () => {
    const dir = tmp();
    put(dir, 'src/a.ts', '');
    put(dir, 'src/b.ts', 'x');
    const grow = onRead('src/a.ts', () =>
      put(dir, 'src/b.ts', 'x'.repeat(150)),
    );
    expect(
      refusal(() => index(dir, { limits: { maxBytes: 100 }, routes: [grow] })),
    ).toMatchObject({ kind: 'too_large', rule: 'bytes read' });
  });

  it('reports pruned folders, so a route folder left out is visible', () => {
    const dir = tmp();
    put(dir, 'build/routes/page.tsx', '');
    put(dir, 'src/vendor/i18n/vi.json', LABEL);
    expect(index(dir).skipped).toEqual([
      { path: 'build', rule: 'pruned' },
      { path: 'src/vendor', rule: 'pruned' },
    ]);
  });

  it('bounds a pathological source file', () => {
    const dir = tmp();
    const deep = `import { z } from 'zod';\n${'('.repeat(50_000)}${'{'.repeat(50_000)}`;
    put(dir, 'src/deep.ts', deep);
    put(dir, 'src/str.ts', `'${'\\'.repeat(100_001)}`);
    const idx = index(dir);
    expect(idx.messages).toEqual([]);
  });
});
