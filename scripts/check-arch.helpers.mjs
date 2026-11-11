/**
 * Shared helpers for the `check-arch.*.test.mjs` files: builds a throwaway git repo, runs
 * `check-arch.mjs` in it and asserts on the outcome. Not a test file (the harness glob is
 * `scripts/*.test.mjs`).
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';

export const GATE = join(dirname(fileURLToPath(import.meta.url)), 'check-arch.mjs');
export const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
export const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('GIT_')));

/** Runs the gate over a temp repo containing `files` (path → text) and optional symlinks (path → target). */
export const run = (files, links = {}, sub = '') => {
  const dir = mkdtempSync(join(tmpdir(), 'check-arch-'));
  dirs.push(dir);
  execFileSync('git', ['init', '-q'], { cwd: dir, env });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  for (const [path, target] of Object.entries(links)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    symlinkSync(target, join(dir, path));
  }
  return spawnSync('node', [GATE], { cwd: join(dir, sub), env, encoding: 'utf8' });
};
export const fails = (files, pattern, links) => {
  const r = run(files, links);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, pattern);
};
export const passes = (files) => {
  const r = run(files);
  assert.equal(r.status, 0, r.stdout + r.stderr);
};

export const PLUGIN = '@acme/flowctl-plugin-example';
export const BOUNDARY = /may not import a plugin/;
