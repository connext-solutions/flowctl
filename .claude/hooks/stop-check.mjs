/**
 * Stop: when the working tree has uncommitted changes under `packages/`, `scripts/` or `package.json`,
 * runs `bun run check` before Claude may stop, so "done" never means a red lint, typecheck,
 * architecture gate or unit test.
 *
 * @remarks Any dirty file counts, not only this session's edits. On the second stop of a turn
 *   (`stop_hook_active`) it lets Claude stop without re-checking, to avoid a loop. Uses the repo's
 *   Node via nvm like the git hooks.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const root = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const { stop_hook_active: again } = JSON.parse(readFileSync(0, 'utf8'));
if (again) process.exit(0);

const changed = execFileSync('git', ['status', '--porcelain', '--', 'packages', 'scripts', 'package.json'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (changed === '') process.exit(0);

const run = spawnSync(
  'sh',
  ['-c', '[ -s "$HOME/.nvm/nvm.sh" ] && . "$HOME/.nvm/nvm.sh" >/dev/null && nvm use >/dev/null 2>&1; bun run check'],
  { cwd: root, encoding: 'utf8' },
);
if (run.status !== 0) {
  const out = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-40).join('\n');
  process.stdout.write(JSON.stringify({ decision: 'block', reason: `bun run check failed; fix it before stopping:\n${out}` }));
}
