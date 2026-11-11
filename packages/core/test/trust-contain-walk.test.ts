import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openRoot, walkContained } from '../src/trust/index.js';

const tmp = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'flowctl-walk-')));

const put = (root: string, rel: string, body = 'x'): void => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
};

describe('walkContained options', () => {
  it('reports a pruned directory without entering it', () => {
    const dir = tmp();
    put(dir, 'node_modules/x/a.md');
    put(dir, 'src/dist/b.md');
    put(dir, 'src/c.md');
    const walked = walkContained(openRoot(dir, 'specs'), {}, undefined, {
      prune: new Set(['node_modules', 'dist']),
    });
    expect(walked.files.map((f) => f.path)).toEqual(['src/c.md']);
    expect(walked.skipped).toEqual([
      { path: 'node_modules', rule: 'pruned' },
      { path: 'src/dist', rule: 'pruned' },
    ]);
  });

  it('neither lists nor charges a file the include predicate refuses', () => {
    const dir = tmp();
    put(dir, 'img/logo.png', 'x'.repeat(4096));
    put(dir, 'img/big.png', 'x'.repeat(8192));
    put(dir, 'docs/a.md', 'x'.repeat(10));
    symlinkSync(join(dir, 'img'), join(dir, 'linked'));
    const walked = walkContained(
      openRoot(dir, 'specs'),
      { maxBytes: 100, maxFileBytes: 5000 },
      undefined,
      { include: (rel) => rel.endsWith('.md') },
    );
    expect(walked.files).toEqual([{ path: 'docs/a.md', size: 10 }]);
    expect(walked.skipped).toEqual([
      { path: 'linked', rule: 'no symbolic link' },
    ]);
  });
});
