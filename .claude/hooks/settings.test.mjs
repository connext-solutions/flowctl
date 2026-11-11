/**
 * Pins the Claude Code permission lists in `.claude/settings.json` (#51, #55): broad patterns that
 * run any file or install any package with no prompt must not come back.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const { permissions } = JSON.parse(
  readFileSync(new URL('../settings.json', import.meta.url), 'utf8'),
);

describe('settings.json permissions', () => {
  it('allows no broad run, install or git patterns', () => {
    for (const p of [
      'Bash(bun run:*)',
      'Bash(bun install:*)',
      'Bash(git branch:*)',
      'Bash(git diff:*)',
      'Bash(git log:*)',
    ])
      assert.ok(!permissions.allow.includes(p), p);
  });

  it('allows exactly the named bun scripts', () => {
    assert.deepEqual(
      permissions.allow.filter((p) => p.startsWith('Bash(bun ')).sort(),
      [
        'Bash(bun install --frozen-lockfile)',
        'Bash(bun run build)',
        'Bash(bun run check)',
        'Bash(bun run fmt)',
        'Bash(bun run fmt:check)',
        'Bash(bun run lint)',
        'Bash(bun run test:accuracy)',
        'Bash(bun run test:browser)',
        'Bash(bun run test:unit)',
        'Bash(bun run typecheck)',
        'Bash(bun run verify)',
      ],
    );
  });

  it('denies session reads anywhere and keeps the .env rules', () => {
    for (const p of [
      'Read(//**/.flows/.auth/**)',
      'Read(//**/flows/.auth/**)',
      'Read(//**/.auth/**/*.json)',
      'Read(./spike/.env)',
      'Read(./**/.env)',
    ])
      assert.ok(permissions.deny.includes(p), p);
  });
});
