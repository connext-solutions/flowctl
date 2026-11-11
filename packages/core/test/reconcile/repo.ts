import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A fresh temporary directory, by its realpath. */
export const tmp = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'flowctl-codeindex-')));

/** Writes `body` at `rel` below `root`, creating the folders. */
export const put = (
  root: string,
  rel: string,
  body: string | Buffer,
): string => {
  const path = join(root, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  return path;
};
