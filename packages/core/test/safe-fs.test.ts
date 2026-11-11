import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '../src/config.js';
import {
  assertNotSymlink,
  ensureDirInside,
  writeFileNoFollow,
} from '../src/safe-fs.js';

const tmp = (): string =>
  realpathSync(mkdtempSync(join(tmpdir(), 'flowctl-safefs-')));
const mode = (p: string): number => statSync(p).mode & 0o777;

describe('ensureDirInside', () => {
  it('refuses a directory that is a symlink', () => {
    const root = tmp();
    const victim = tmp();
    symlinkSync(victim, join(root, '.runs'));
    expect(() => ensureDirInside(join(root, '.runs'), root)).toThrow(
      ConfigError,
    );
    expect(() => ensureDirInside(join(root, '.runs'), root)).toThrow(/symlink/);
  });

  it('refuses a directory under a symlinked parent that leaves root', () => {
    const root = tmp();
    const victim = tmp();
    symlinkSync(victim, join(root, '.auth'));
    expect(() => ensureDirInside(join(root, '.auth', 'local'), root)).toThrow(
      ConfigError,
    );
    expect(existsSync(join(victim, 'local'))).toBe(false);
  });

  it('accepts a root that is itself a symlink to a real directory', () => {
    const real = tmp();
    const link = join(tmp(), 'flows');
    symlinkSync(real, link);
    expect(ensureDirInside(join(link, '.runs'), link)).toBe(
      join(real, '.runs'),
    );
  });

  it('creates the directory with a mode and a catch-all .gitignore', () => {
    const root = tmp();
    const dir = ensureDirInside(join(root, '.auth'), root, {
      mode: 0o700,
      gitignoreAll: true,
    });
    expect(mode(dir)).toBe(0o700);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('*\n');
  });
});

describe('writeFileNoFollow', () => {
  it('replaces a symlink instead of writing through it', () => {
    const dir = tmp();
    const target = join(tmp(), 'tracked.json');
    writeFileSync(target, 'ORIGINAL');
    symlinkSync(target, join(dir, 'state.json'));
    writeFileNoFollow(join(dir, 'state.json'), '{"cookies":[]}', 0o600);
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL');
    expect(lstatSync(join(dir, 'state.json')).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(dir, 'state.json'), 'utf8')).toBe(
      '{"cookies":[]}',
    );
    expect(mode(join(dir, 'state.json'))).toBe(0o600);
  });
});

describe('assertNotSymlink', () => {
  it('throws on a symlink and passes on a missing or regular path', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'real.json'), '{}');
    symlinkSync(join(dir, 'real.json'), join(dir, 'link.json'));
    expect(() => assertNotSymlink(join(dir, 'link.json'))).toThrow(ConfigError);
    expect(() => assertNotSymlink(join(dir, 'missing.json'))).not.toThrow();
    expect(() => assertNotSymlink(join(dir, 'real.json'))).not.toThrow();
  });
});
